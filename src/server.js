import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import bcrypt from "bcrypt";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

// ตั้งค่าการเชื่อมต่อ Supabase — ใช้ environment variable เท่านั้น ไม่ hardcode
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ SUPABASE_URL และ SUPABASE_ANON_KEY ต้องกำหนดใน .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

app.use(cors());
app.use(express.json());

// แปลง email ให้เป็น lowercase และตัด whitespace
function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

// สร้าง HTTP Error พร้อม status code
function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// แปลง object ที่อยู่เป็น string เดียว
function buildAddressText(address) {
  if (!address) return "";
  return [
    address.address_detail,
    address.subdistrict,
    address.district,
    address.province,
    address.zipcode,
  ]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(", ");
}

// ใส่ filter เพิ่มเติมให้กับ Supabase query
function applyFilters(query, filters = []) {
  let nextQuery = query;
  for (const filter of filters) {
    if (filter.type === "eq") {
      nextQuery = nextQuery.eq(filter.column, filter.value);
    } else if (filter.type === "ilike") {
      nextQuery = nextQuery.ilike(filter.column, filter.value);
    } else if (filter.type === "or") {
      // sanitize: ป้องกัน injection เบื้องต้น
      const safe = String(filter.value).replace(/[;'"\\]/g, "");
      nextQuery = nextQuery.or(safe);
    }
  }
  return nextQuery;
}

// คำนวณค่าส่งตามน้ำหนัก
function calculateShippingCost(weight) {
  if (weight <= 1) return 45;
  if (weight <= 3) return 75;
  if (weight <= 5) return 120;
  return 180;
}

// สร้าง tracking number แบบสุ่ม
function generateTrackingNumber() {
  const alphabet = "123456789";
  let value = "TH";
  for (let index = 0; index < 9; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function resolveBranchId(trackingRow) {
  return (
    trackingRow.branch_id ??
    trackingRow.current_branch_id ??
    trackingRow.origin_branch_id ??
    trackingRow.destination_branch_id ??
    null
  );
}

async function getUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const { data, error } = await supabase
    .from("users")
    .select()
    .eq("email", normalizedEmail)
    .limit(1);

  if (error) throw error;
  return data?.[0] ?? null;
}

async function getUserById(userId) {
  if (!userId) return null;

  const { data, error } = await supabase
    .from("users")
    .select()
    .eq("user_id", userId)
    .limit(1);

  if (error) throw error;
  return data?.[0] ?? null;
}

async function getPrimaryAddress(userId) {
  const { data, error } = await supabase
    .from("address")
    .select()
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] ?? null;
}

async function getUniqueTrackingNumber() {
  for (let attempts = 0; attempts < 15; attempts += 1) {
    const trackingNumber = generateTrackingNumber();
    const { data, error } = await supabase
      .from("shipment")
      .select("tracking_number")
      .eq("tracking_number", trackingNumber)
      .limit(1);

    if (error) throw error;
    if (!data?.length) return trackingNumber;
  }
  throw createHttpError(500, "ไม่สามารถสร้าง Tracking Number ได้");
}

// ─────────────────────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shipment Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/shipments/summary/:trackingNumber", async (req, res, next) => {
  try {
    const trackingNumber = String(req.params.trackingNumber ?? "").trim().toUpperCase();
    const { data, error } = await supabase
      .from("shipment")
      .select(`
        shipment_id, tracking_number, status,
        shipping_cost, shipment_date, estimated_delivery,
        receiver_address, sender_detail,
        sender_id, receiver_id, driver_id,
        sender:users!shipment_sender_id_fkey(name, phone),
        receiver:users!shipment_receiver_id_fkey(name, phone)
      `)
      .ilike("tracking_number", trackingNumber)
      .limit(1);

    if (error) throw error;
    const shipment = data?.[0] ?? null;
    if (!shipment) throw createHttpError(404, "ไม่พบข้อมูลพัสดุ");
    res.json(shipment);
  } catch (error) {
    next(error);
  }
});

app.get("/api/shipments/track/:trackingNumber", async (req, res, next) => {
  try {
    const { data: shipmentRows, error: shipmentError } = await supabase
      .from("shipment")
      .select()
      .ilike("tracking_number", req.params.trackingNumber.trim().toUpperCase())
      .limit(1);

    if (shipmentError) throw shipmentError;
    const shipment = shipmentRows?.[0] ?? null;
    if (!shipment) throw createHttpError(404, "ไม่พบพัสดุ");

    const { data: trackingRows, error: trackingError } = await supabase
      .from("shipment_tracking")
      .select()
      .eq("shipment_id", shipment.shipment_id)
      .order("timestamp", { ascending: false });

    if (trackingError) throw trackingError;

    const branchIds = [
      ...new Set(
        (trackingRows ?? []).map(resolveBranchId).filter((id) => id != null),
      ),
    ];

    let branchMap = {};
    if (branchIds.length > 0) {
      const { data: branchRows, error: branchError } = await supabase
        .from("branch")
        .select("branch_id, name")
        .in("branch_id", branchIds);

      if (branchError) throw branchError;
      branchMap = Object.fromEntries(
        (branchRows ?? []).map((branch) => [branch.branch_id, branch]),
      );
    }

    const trackingList = (trackingRows ?? []).map((row) => ({
      ...row,
      branch: branchMap[resolveBranchId(row)] ?? null,
    }));

    res.json({ shipment, trackingList });
  } catch (error) {
    next(error);
  }
});

app.get("/api/shipments/delivered/:userId", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("shipment")
      .select(
        "shipment_id, tracking_number, status, receiver_address, shipment_date, estimated_delivery, request_id, request(parcel_id, parcels(weight, width, height, length))",
      )
      .eq("receiver_id", Number(req.params.userId))
      .eq("status", "delivered")
      .order("shipment_date", { ascending: false });

    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

app.get("/api/shipments", async (req, res) => {
  try {
    const { data, error } = await supabase.from("shipment").select();
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch shipments", error: error.message });
  }
});

app.post("/api/shipments/confirm", async (req, res, next) => {
  try {
    const { senderId, receiverId, requestId, parcelId, parcelWeight, quantity, receiverAddress } = req.body;

    const senderAddress = await getPrimaryAddress(senderId);
    const senderDetail = buildAddressText(senderAddress);
    const trackingNumber = await getUniqueTrackingNumber();
    const now = new Date();
    const estimatedDelivery = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const { data: shipmentRows, error: insertShipmentError } = await supabase
      .from("shipment")
      .insert({
        sender_id: senderId,
        receiver_id: receiverId,
        receiver_address: receiverAddress,
        sender_detail: senderDetail,
        shipping_cost: calculateShippingCost(Number(parcelWeight)),
        shipment_date: now.toISOString(),
        estimated_delivery: estimatedDelivery.toISOString(),
        status: "waiting_driver",
        tracking_number: trackingNumber,
        request_id: requestId,
      })
      .select();

    if (insertShipmentError) throw insertShipmentError;

    const { error: updateParcelError } = await supabase
      .from("parcels")
      .update({ quantity })
      .eq("parcel_id", parcelId);

    if (updateParcelError) throw updateParcelError;

    const { error: updateRequestError } = await supabase
      .from("request")
      .update({ status: "waiting_driver" })
      .eq("request_id", requestId);

    if (updateRequestError) throw updateRequestError;

    res.status(201).json({ trackingNumber, shipment: shipmentRows?.[0] ?? null });
  } catch (error) {
    next(error);
  }
});

app.post("/api/shipments/:shipmentId/assign-driver", async (req, res) => {
  const shipmentId = Number(req.params.shipmentId);
  const driverId = Number(req.body?.driverId);

  if (!shipmentId || !driverId) {
    return res.status(400).json({ message: "shipmentId and driverId are required" });
  }

  try {
    const { error: shipmentError } = await supabase
      .from("shipment")
      .update({ driver_id: driverId, status: "กำลังจัดส่ง" })
      .eq("shipment_id", shipmentId);

    if (shipmentError) throw shipmentError;

    const { data: shipmentData, error: fetchError } = await supabase
      .from("shipment")
      .select("request_id")
      .eq("shipment_id", shipmentId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    const requestId = shipmentData?.request_id;
    if (requestId != null) {
      const { error: requestError } = await supabase
        .from("request")
        .update({ status: "กำลังจัดส่ง" })
        .eq("request_id", requestId);

      if (requestError) throw requestError;
    }

    return res.json({ success: true, shipmentId, requestId: requestId ?? null });
  } catch (error) {
    return res.status(500).json({ message: "Failed to assign driver", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// User Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/users/lookup", async (req, res, next) => {
  try {
    const user = req.query.email
      ? await getUserByEmail(req.query.email)
      : await getUserById(req.query.userId);

    if (!user) return res.status(404).json({ error: "ไม่พบผู้ใช้" });

    // ไม่ส่ง password กลับไปให้ client เด็ดขาด
    const { password: _password, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

app.get("/api/users/search", async (req, res, next) => {
  try {
    const query = String(req.query.q ?? "").trim();
    const excludeUserId = Number(req.query.excludeUserId || 0);

    if (!query) return res.json([]);

    const { data, error } = await supabase
      .from("users")
      .select("user_id, name, email, phone")
      .or(`name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`)
      .limit(20);

    if (error) throw error;

    const results = (data ?? []).filter((item) => item.user_id !== excludeUserId);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/users/wallet", async (req, res, next) => {
  try {
    const { email, wallet } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const { error: updateError } = await supabase
      .from("users")
      .update({ wallet })
      .eq("email", normalizedEmail);

    if (updateError) throw updateError;

    const user = await getUserByEmail(normalizedEmail);
    if (!user) throw createHttpError(404, "ไม่พบผู้ใช้");

    const { password: _password, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth Routes
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post("/api/auth/register", async (req, res, next) => {
  try {
    const { name, email, password, phone, address } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!password || password.length < 6) {
      throw createHttpError(400, "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร");
    }

    const existingUser = await getUserByEmail(normalizedEmail);
    if (existingUser) throw createHttpError(409, "อีเมลนี้ถูกใช้งานแล้ว");

    // ✅ Hash password ด้วย bcrypt ฝั่ง server
    const hashedPassword = await bcrypt.hash(String(password), 12);

    const { data: newUser, error: userError } = await supabase
      .from("users")
      .insert({
        name: String(name ?? "").trim(),
        email: normalizedEmail,
        password: hashedPassword,
        phone: String(phone ?? "").trim(),
        wallet: 0,
      })
      .select()
      .single();

    if (userError) throw userError;

    if (address) {
      const { error: addressError } = await supabase.from("address").insert({
        user_id: newUser.user_id,
        address_detail: String(address.address_detail ?? "").trim(),
        province: String(address.province ?? "").trim(),
        district: String(address.district ?? "").trim(),
        subdistrict: String(address.subdistrict ?? "").trim(),
        zipcode: String(address.zipcode ?? "").trim(),
        label: String(address.label ?? "บ้าน").trim(),
        is_default: true,
      });

      if (addressError) throw addressError;
    }

    // ✅ ไม่ส่ง password กลับไป
    const { password: _password, ...safeUser } = newUser;
    res.status(201).json(safeUser);
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/login
app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await getUserByEmail(normalizeEmail(email));

    // ✅ ใช้ bcrypt.compare แทนการ query ตรง
    const isMatch = user && await bcrypt.compare(String(password ?? ""), user.password);
    if (!isMatch) {
      throw createHttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    }

    // ✅ ไม่ส่ง password กลับไป
    const { password: _password, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Address Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/addresses/user/:userId", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("address")
      .select()
      .eq("user_id", Number(req.params.userId))
      .order("is_default", { ascending: false });

    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

app.post("/api/addresses", async (req, res, next) => {
  try {
    const { user_id, address_detail, province, district, subdistrict, zipcode, label } = req.body;
    const { data, error } = await supabase
      .from("address")
      .insert({ user_id, address_detail, province, district, subdistrict, zipcode, label: label || "บ้าน", is_default: false })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/addresses/:id", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("address")
      .update(req.body)
      .eq("address_id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/addresses/:id", async (req, res, next) => {
  try {
    const { error } = await supabase.from("address").delete().eq("address_id", req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.patch("/api/addresses/:id/default", async (req, res, next) => {
  try {
    const { user_id } = req.body;
    await supabase.from("address").update({ is_default: false }).eq("user_id", user_id);
    const { data, error } = await supabase
      .from("address")
      .update({ is_default: true })
      .eq("address_id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/branches", async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from("branch").select().order("branch_id");
    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Request Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/requests/user/:userId", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("request")
      .select("*, parcels(*), shipment(shipment_id, tracking_number, status, receiver_address)")
      .eq("user_id", Number(req.params.userId))
      .order("date", { ascending: false });

    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

app.get("/api/requests/pending", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("request")
      .select("*, shipment(shipment_id, tracking_number, status)")
      .eq("status", "pending");

    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch pending requests", error: error.message });
  }
});

app.post("/api/requests/:requestId/approve", async (req, res) => {
  const requestId = Number(req.params.requestId);
  const driverId = Number(req.body?.driverId);

  if (!requestId || !driverId) {
    return res.status(400).json({ message: "requestId and driverId are required" });
  }

  try {
    const { data: requestData, error: requestError } = await supabase
      .from("request")
      .select("request_id, shipment(shipment_id)")
      .eq("request_id", requestId)
      .single();

    if (requestError) throw requestError;

    const shipmentRelation = requestData?.shipment;
    let shipmentId = null;

    if (Array.isArray(shipmentRelation) && shipmentRelation.length > 0) {
      shipmentId = shipmentRelation[0]?.shipment_id ?? null;
    } else if (shipmentRelation && typeof shipmentRelation === "object") {
      shipmentId = shipmentRelation.shipment_id ?? null;
    }

    if (!shipmentId) {
      return res.status(404).json({ message: "Shipment not found for this request" });
    }

    const now = new Date();
    const estimatedDelivery = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const { error: shipmentError } = await supabase
      .from("shipment")
      .update({ driver_id: driverId, shipment_date: now.toISOString(), estimated_delivery: estimatedDelivery.toISOString(), status: "กำลังจัดส่ง" })
      .eq("shipment_id", shipmentId);

    if (shipmentError) throw shipmentError;

    const { error: approveError } = await supabase
      .from("request")
      .update({ status: "approved" })
      .eq("request_id", requestId);

    if (approveError) throw approveError;

    return res.json({ success: true, requestId, shipmentId });
  } catch (error) {
    return res.status(500).json({ message: "Failed to approve request", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Consignment & Return Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/consignments", async (req, res, next) => {
  try {
    const { userId, weight, width, height, length, reason = null, image = null, status = "pending", type = "consignment" } = req.body;

    const { data: parcel, error: parcelError } = await supabase
      .from("parcels")
      .insert({ weight, width, height, length, status: "pending" })
      .select()
      .single();

    if (parcelError) throw parcelError;

    const { data: requestRow, error: requestError } = await supabase
      .from("request")
      .insert({ parcel_id: parcel.parcel_id, user_id: userId, reason, image, status, type })
      .select()
      .single();

    if (requestError) throw requestError;

    res.status(201).json({ parcel, request: requestRow });
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns", async (req, res, next) => {
  try {
    const { currentUserId, requestId, shipmentId, reason, image } = req.body;

    const { data: shipment, error: shipmentError } = await supabase
      .from("shipment")
      .select("sender_id, sender_detail")
      .eq("shipment_id", shipmentId)
      .single();

    if (shipmentError) throw shipmentError;

    const oldSenderId = shipment.sender_id ?? null;
    let newReceiverAddress = shipment.sender_detail ?? "";

    if (!newReceiverAddress && oldSenderId) {
      const oldSenderAddress = await getPrimaryAddress(oldSenderId);
      newReceiverAddress = buildAddressText(oldSenderAddress);
    }

    const currentUserAddress = await getPrimaryAddress(currentUserId);
    const newSenderDetail = buildAddressText(currentUserAddress);

    const { error: requestError } = await supabase
  .from("request")
  .update({
    user_id: currentUserId,   // ← เพิ่มบรรทัดนี้
    reason,
    image,
    date: new Date().toISOString(),
    status: "pending",
    type: "return",
  })
  .eq("request_id", requestId);
  
    // const { error: requestError } = await supabase
    //   .from("request")
    //   .update({ reason, image, date: new Date().toISOString(), status: "pending", type: "return" })
    //   .eq("request_id", requestId);

    if (requestError) throw requestError;

    const { error: updateShipmentError } = await supabase
      .from("shipment")
      .update({ sender_id: currentUserId, receiver_id: oldSenderId, receiver_address: newReceiverAddress, sender_detail: newSenderDetail, status: "pending", driver_id: null })
      .eq("shipment_id", shipmentId);

    if (updateShipmentError) throw updateShipmentError;

    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/shipping/calculate",
  async (req, res) => {
    try {
      const {
        weight,
        width,
        height,
        length,
        distanceKm,
      } = req.body;

      // น้ำหนักปริมาตร
      const volumeWeight =
        (width * height * length) / 5000;

      // ใช้น้ำหนักที่มากกว่า
      const finalWeight = Math.max(
        weight,
        volumeWeight
      );

      // หา rate
      const { data: rate, error } =
        await supabase
          .from("shipping_rate")
          .select("*")
          .lte("min_weight", finalWeight)
          .gte("max_weight", finalWeight)
          .single();

      if (error || !rate) {
        return res.status(404).json({
          error:
            "ไม่พบอัตราค่าจัดส่ง",
        });
      }

      // คำนวณราคา
      const shippingCost =
        Number(rate.base_price) +
        Number(distanceKm) *
          Number(rate.price_per_km);

      res.json({
        success: true,

        finalWeight:
          Number(finalWeight.toFixed(2)),

        volumeWeight:
          Number(volumeWeight.toFixed(2)),

        distanceKm,

        shippingCost:
          Number(
            shippingCost.toFixed(2)
          ),

        rate,
      });
    } catch (e) {
      res.status(500).json({
        error: e.message,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Generic DB Routes
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ WARNING: endpoint เหล่านี้ควรเพิ่ม JWT middleware ก่อน deploy production
// เช่น app.post("/api/db/select", requireAuth, async (req, res, next) => { ... })

app.post("/api/db/select", async (req, res, next) => {
  try {
    const { table, columns = "*", filters = [], orderBy = null, limit = null, single = false, maybeSingle = false } = req.body;

    let query = supabase.from(table).select(columns);
    query = applyFilters(query, filters);

    if (orderBy?.column) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending !== false });
    }

    if (typeof limit === "number") query = query.limit(limit);

    const { data, error } = await query;
    if (error) throw error;

    if (single) {
      if (!data?.length) throw createHttpError(404, "ไม่พบข้อมูล");
      return res.json(data[0]);
    }

    if (maybeSingle) return res.json(data?.[0] ?? null);

    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

app.post("/api/db/insert", async (req, res, next) => {
  try {
    const { table, payload, columns = "*", single = false } = req.body;

    let query = supabase.from(table).insert(payload);
    if (columns) query = query.select(columns);

    const { data, error } = await query;
    if (error) throw error;

    if (single) return res.json(data?.[0] ?? null);

    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

app.post("/api/db/update", async (req, res, next) => {
  try {
    const { table, payload, filters = [], columns = null, single = false, maybeSingle = false } = req.body;

    let query = supabase.from(table).update(payload);
    query = applyFilters(query, filters);

    if (columns) query = query.select(columns);

    const { data, error } = await query;
    if (error) throw error;

    if (single) return res.json(data?.[0] ?? null);
    if (maybeSingle) return res.json(data?.[0] ?? null);

    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/admin/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();

  if (!username || !password) {
    return res.status(400).json({ message: "username and password are required" });
  }

  try {
    const { data, error } = await supabase
      .from("admin")
      .select()
      .eq("username", username)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    // ✅ ถ้า admin password ยัง plain text ให้เปลี่ยนเป็น bcrypt ด้วย
    // ตอนนี้ fallback เปรียบเทียบตรงก่อน (ระหว่าง migrate)
    const isMatch = data.password.startsWith("$2")
      ? await bcrypt.compare(password, data.password)
      : data.password === password;

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const { password: _password, ...safeAdmin } = data;
    return res.json({ name: data.name, admin: safeAdmin });
  } catch (error) {
    return res.status(500).json({ message: "Failed to login", error: error.message });
  }
});

app.get("/api/drivers", async (req, res) => {
  try {
    const { data, error } = await supabase.from("driver").select();
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch drivers", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Rider Routes
// ─────────────────────────────────────────────────────────────────────────────

const riderRouter = express.Router();

riderRouter.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const { data, error } = await supabase
      .from("driver")
      .select()
      .eq("email", normalizeEmail(email))
      .maybeSingle();

    if (error) throw error;

    if (!data) throw createHttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");

    // ✅ bcrypt compare (รองรับทั้ง hash และ plain text ระหว่าง migrate)
    const isMatch = data.password.startsWith("$2")
      ? await bcrypt.compare(password, data.password)
      : data.password === password;

    if (!isMatch) throw createHttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");

    const { password: _password, ...safeRider } = data;
    res.json({ rider: safeRider });
  } catch (error) {
    next(error);
  }
});

riderRouter.get("/parcels", async (req, res, next) => {
  try {
    const driverId = Number(req.query.driverId);
    if (!driverId) return res.status(400).json({ error: "driverId is required" });

    const { data, error } = await supabase
      .from("shipment")
      .select(`
        shipment_id, tracking_number, status, receiver_address, sender_detail,
        shipping_cost, shipment_date, estimated_delivery, request_id,
        sender:users!shipment_sender_id_fkey(name, phone),
        receiver:users!shipment_receiver_id_fkey(name, phone),
        request(parcel_id, parcels(weight, width, height, length))
      `)
      .eq("driver_id", driverId)
      .order("shipment_date", { ascending: false });

    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

riderRouter.get("/parcels/tracking/:trackingNumber", async (req, res, next) => {
  try {
    const trackingNumber = String(req.params.trackingNumber ?? "").trim().toUpperCase();

    const { data, error } = await supabase
      .from("shipment")
      .select(`
        shipment_id, tracking_number, status, receiver_address, sender_detail,
        shipping_cost, shipment_date, estimated_delivery, request_id,
        sender:users!shipment_sender_id_fkey(name, phone),
        receiver:users!shipment_receiver_id_fkey(name, phone),
        request(parcel_id, parcels(weight, width, height, length))
      `)
      .ilike("tracking_number", trackingNumber)
      .limit(1);

    if (error) throw error;

    const shipment = data?.[0] ?? null;
    if (!shipment) throw createHttpError(404, "ไม่พบพัสดุ");

    res.json(shipment);
  } catch (error) {
    next(error);
  }
});

riderRouter.patch("/parcels/:shipmentId/status", async (req, res, next) => {
  try {
    const shipmentId = Number(req.params.shipmentId);
    const status = String(req.body?.status ?? "").trim();

    if (!shipmentId) {
      return res.status(400).json({
        error: "shipmentId is required",
      });
    }

    const validStatuses = ["กำลังจัดส่ง", "delivered", "failed"];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // update shipment
    const { data, error } = await supabase
      .from("shipment")
      .update({ status })
      .eq("shipment_id", shipmentId)
      .select(`
        shipment_id,
        tracking_number,
        status,
        receiver_address,
        sender_detail,
        shipping_cost,
        shipment_date,
        estimated_delivery,
        request_id
      `)
      .single();

    if (error) throw error;

    // update request
    if (status === "delivered" && data.request_id) {
      const { error: requestError } = await supabase
        .from("request")
        .update({ status: "delivered" })
        .eq("request_id", data.request_id);

      if (requestError) throw requestError;
    }

    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.use("/api/rider", riderRouter);

// ─────────────────────────────────────────────────────────────────────────────
// Global Error Handler
// ─────────────────────────────────────────────────────────────────────────────

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  const message = error.message || error.details || "The server could not complete the request.";
  res.status(status).json({ error: message, details: error.details ?? null, code: error.code ?? null });
});

app.listen(port, () => {
  console.log(`Node API listening on http://localhost:${port}`);
});
