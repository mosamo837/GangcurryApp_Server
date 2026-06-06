import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import bcrypt from "bcrypt";
import { createClient } from "@supabase/supabase-js";

import promptpay from "promptpay-qr";
import QRCode from "qrcode";

import fetch from 'node-fetch';

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
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "50mb",
}));

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

// เพิ่ม helper function ใน server.js
async function geocodeAddress(addressDetail, subdistrict, district, province, zipcode) {
  // ลอง query หลายแบบเรียงจากละเอียดไปหยาบ
  const queries = [
    `${district} ${province} Thailand`,
    `${province} Thailand`,
    `${zipcode} Thailand`,
  ];

  for (const query of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=th`;
      console.log('🔍 Trying:', query);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ParcelDeliveryApp/1.0',
          'Accept': 'application/json',
        },
      });

      const data = await response.json();

      if (data && data.length > 0) {
        console.log('✅ Found with query:', query, data[0].lat, data[0].lon);
        return {
          latitude: parseFloat(data[0].lat),
          longitude: parseFloat(data[0].lon),
        };
      }

      console.log('⚠️ Not found:', query);

      // Nominatim มี rate limit 1 request/sec
      await new Promise((resolve) => setTimeout(resolve, 1100));
    } catch (e) {
      console.error('❌ Error:', e);
    }
  }

  return null;
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
//ดึงข้อมูลuser
app.get("/api/users", async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("user_id, name, email, phone, wallet")
      .is("deleted_at", null)
      .order("user_id", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/users/:userId — อัปเดตข้อมูล user
app.patch("/api/users/:userId", async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    const allowed = ["name", "email", "phone", "profile"];
    const updateData = {};

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updateData[key] = key === "email"
          ? normalizeEmail(req.body[key])
          : String(req.body[key]).trim();
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "ไม่มีข้อมูลที่จะอัปเดต" });
    }

    // ตรวจ email ซ้ำ (ถ้ามีการเปลี่ยน email)
    if (updateData.email) {
      const existing = await getUserByEmail(updateData.email);
      if (existing && existing.user_id !== userId) {
        throw createHttpError(409, "อีเมลนี้ถูกใช้งานแล้ว");
      }
    }

    const { data, error } = await supabase
      .from("users")
      .update(updateData)
      .eq("user_id", userId)
      .select("user_id, name, email, phone, wallet")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get('/api/driver/:driverId/wallet', async (req, res, next) => {
  try {
    const driverId = Number(req.params.driverId);

    const { data, error } = await supabase
      .from('driver')
      .select('wallet')
      .eq('driver_id', driverId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'ไม่พบคนขับ' });
    }

    res.json({ wallet: data.wallet });
  } catch (error) {
    next(error);
  }
});

// API ลบผู้ใช้
app.delete("/api/users/:userId", async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);

    const { data: existingUser, error: findError } = await supabase
      .from("users")
      .select("user_id, name, email")
      .eq("user_id", userId)
      .maybeSingle();

    if (findError) throw findError;
    if (!existingUser) {
      return res.status(404).json({ error: "ไม่พบผู้ใช้" });
    }

    // soft delete — mark เวลาที่ลบ แทนการลบจริง
    const { error } = await supabase
      .from("users")
      .update({ deleted_at: new Date().toISOString() })
      .eq("user_id", userId);

    if (error) throw error;

    res.json({
      message: "ลบผู้ใช้สำเร็จ",
      deleted: existingUser,
    });
  } catch (error) {
    next(error);
  }
});

// ── ประวัติการเติมเงิน
app.get("/api/wallet/history/:userId", async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);

    const { data, error } = await supabase
      .from("wallet_transaction")
      .select("*")
      .eq("user_id", userId)
      // .eq("type", "topup")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

// ── ดึง QR ของ transaction ที่ pending อยู่
app.get("/api/wallet/qr/:transactionId", async (req, res, next) => {
  try {
    const transactionId = Number(req.params.transactionId);

    const { data: transaction, error } = await supabase
      .from("wallet_transaction")
      .select("*")
      .eq("transaction_id", transactionId)
      .single();

    if (error || !transaction) {
      throw createHttpError(404, "ไม่พบ transaction");
    }

    // สร้าง QR ใหม่จาก amount เดิม
    const payload = promptpay("0855275914", {
      amount: Number(transaction.amount),
    });
    const qrCode = await QRCode.toDataURL(payload);

    res.json({
      transaction_id: transaction.transaction_id,
      amount: transaction.amount,
      qr_code: qrCode,
      status: transaction.status,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/driver/commission', async (req, res, next) => {
  try {
    const { driverId, amount, shipmentId, note } = req.body;

    if (!driverId || !amount) {
      return res.status(400).json({ error: 'driverId and amount are required' });
    }

    // ── 1. ดึง wallet ปัจจุบัน ──
    const { data: driver, error: fetchError } = await supabase
      .from('driver')
      .select('wallet')
      .eq('driver_id', driverId)
      .single();

    if (fetchError || !driver) {
      return res.status(404).json({ error: 'ไม่พบคนขับ' });
    }

    const newWallet = Number(driver.wallet || 0) + Number(amount);

    // ── 2. เพิ่ม wallet driver ──
    const { error: walletError } = await supabase
      .from('driver')
      .update({ wallet: newWallet })
      .eq('driver_id', driverId);

    if (walletError) throw walletError;

    // ── 3. บันทึกลง wallet_transaction ──
    const { error: txError } = await supabase
      .from('wallet_transaction')
      .insert({
        driver_id: Number(driverId),
        amount: Number(amount),
        type: 'commission',
        status: 'completed',
        note: note ?? `commission shipment #${shipmentId}`,
      });

    if (txError) throw txError;

    res.json({ success: true, commission: amount, wallet: newWallet });
  } catch (error) {
    next(error);
  }
});



// GET /api/shipment-tracking/branch/:branchId
app.get('/api/shipment-tracking/branch/:branchId', async (req, res) => {
  try {
    const branchId = Number(req.params.branchId);

    const { data, error } = await supabase
      .from('shipment_tracking')
      .select('*')
      .or(`branch_start.eq.${branchId},branch_end.eq.${branchId}`)
      .order('timestamp', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({
      message: err.message || 'Fetch shipment tracking failed',
    });
  }
});

// GET /api/shipments/tracking-branch/:branchId
app.get('/api/shipments/tracking-branch/:branchId', async (req, res) => {
  try {
    const branchId = Number(req.params.branchId);

    const { data: trackings, error: trackingError } = await supabase
      .from('shipment_tracking')
      .select('shipment_id')
      .or(`branch_start.eq.${branchId},branch_end.eq.${branchId}`);

    if (trackingError) throw trackingError;

    const shipmentIds = [...new Set(trackings.map(t => t.shipment_id))];

    if (shipmentIds.length === 0) {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from('shipment')
      .select('*')
      .in('shipment_id', shipmentIds);

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({
      message: err.message || 'Fetch shipments by tracking branch failed',
    });
  }
});

// แก้ไข Shipment
app.put("/api/shipment/:shipmentId", async (req, res, next) => {
  try {
    const shipmentId = Number(req.params.shipmentId);
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
      return res.status(400).json({ error: "shipmentId ไม่ถูกต้อง" });
    }

    const {
      sender_id,
      receiver_id,
      driver_id,
      receiver_address,
      shipping_cost,
      shipment_date,
      estimated_delivery,
      status,
      note,
      tracking_number,
      request_id,
      sender_detail,
    } = req.body;

    const updateData = {};

    if (sender_id !== undefined) updateData.sender_id = sender_id === null ? null : Number(sender_id);
    if (receiver_id !== undefined) updateData.receiver_id = receiver_id === null ? null : Number(receiver_id);
    if (driver_id !== undefined) updateData.driver_id = driver_id === null ? null : Number(driver_id);
    if (request_id !== undefined) updateData.request_id = request_id === null ? null : Number(request_id);

    if (receiver_address !== undefined) updateData.receiver_address = receiver_address;
    if (sender_detail !== undefined) updateData.sender_detail = sender_detail;
    if (status !== undefined) updateData.status = status;
    if (note !== undefined) updateData.note = note;
    if (tracking_number !== undefined) updateData.tracking_number = tracking_number;

    if (shipment_date !== undefined) updateData.shipment_date = shipment_date;
    if (estimated_delivery !== undefined) updateData.estimated_delivery = estimated_delivery;

    if (shipping_cost !== undefined && shipping_cost !== "") {
      updateData.shipping_cost = Number(shipping_cost);
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "ไม่มีข้อมูลสำหรับแก้ไข" });
    }

    const { data, error } = await supabase
      .from("shipment")
      .update(updateData)
      .eq("shipment_id", shipmentId)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error("Update shipment error:", error);
    next(error);
  }
});

// ลบ Shipment
app.delete("/api/shipment/:shipmentId", async (req, res, next) => {
  try {
    const { shipmentId } = req.params;

    // ลบข้อมูลลูกที่ผูก shipment ก่อน ถ้ามี foreign key
    await supabase
      .from("shipment_tracking")
      .delete()
      .eq("shipment_id", shipmentId);

    await supabase
      .from("payment")
      .delete()
      .eq("shipment_id", shipmentId);

    const { error } = await supabase
      .from("shipment")
      .delete()
      .eq("shipment_id", shipmentId);

    if (error) throw error;

    res.json({ message: "ลบ Shipment สำเร็จ" });
  } catch (error) {
    next(error);
  }
});

app.get('/api/shipments/:shipmentId/detail', async (req, res) => {
  const shipmentId = Number(req.params.shipmentId);

  if (!Number.isInteger(shipmentId)) {
    return res.status(400).json({ message: "Invalid shipmentId" });
  }

  try {
    const { data: shipment, error: shipmentError } = await supabase
      .from("shipment")
      .select(`
        *,
        sender:users!shipment_sender_id_fkey(*),
        receiver:users!shipment_receiver_id_fkey(*),
        driver:driver!shipment_driver_id_fkey(*),
        request(
          *,
          parcels(*)
        )
      `)
      .eq("shipment_id", shipmentId)
      .maybeSingle();

    if (shipmentError) throw shipmentError;
    if (!shipment) {
      return res.status(404).json({ message: "Shipment not found" });
    }

    const { data: proofs, error: proofError } = await supabase
      .from("proof")
      .select("*")
      .eq("shipment_id", shipmentId);

    if (proofError) throw proofError;

    const parcel = shipment.request?.parcels ?? null;

    return res.json({
      ...shipment,
      parcels: parcel ? [parcel] : [],
      proofs: proofs || [],
    });
  } catch (error) {
    console.error("GET /shipments/:shipmentId/detail error:", error);
    return res.status(500).json({
      message: "Failed to fetch shipment detail",
      error: error.message,
    });
  }
});

// ดึง proof ตาม shipment_id
app.get("/api/proofs/shipment/:shipmentId", async (req, res, next) => {
  try {
    const { shipmentId } = req.params;

    const { data, error } = await supabase
      .from("proof")
      .select("*")
      .eq("shipment_id", shipmentId)
      .order("date", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/proofs", async (req, res, next) => {
  try {
    const { shipmentId } = req.query;

    let query = supabase.from("proof").select("*");

    if (shipmentId) {
      query = query.eq("shipment_id", shipmentId);
    }

    const { data, error } = await query.order("date", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    next(error);
  }
});

/////////////////////////////////////////////////////////////////driver//////////////////////////////////////////////////
// API แก้ไขข้อมูลไดรเวอร์
app.post("/api/drivers", async (req, res, next) => {
  try {
    const {
      bid,
      name,
      email,
      password,
      phone,
      car_plate,
      address,
      national_id,
      wallet = 0,
      profile = null,
    } = req.body;

    const { data, error } = await supabase
      .from("driver")
      .insert({
        bid: bid ?? null,
        name,
        email,
        password,
        phone,
        car_plate,
        address,
        national_id,
        wallet,
        profile,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

// API แก้ไขไดรเวอร์
app.put("/api/drivers/:driverId", async (req, res, next) => {
  try {
    const { driverId } = req.params;

    const allowed = [
      "bid", "name", "email", "password", "phone",
      "car_plate", "profile", "wallet", "address", "national_id",
    ];

    const updateData = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updateData[key] = req.body[key];
    }

    if (updateData.bid !== undefined && updateData.bid === undefined) {
      updateData.bid = updateData.bid;
      delete updateData.bid;
    }

    const { data, error } = await supabase
      .from("driver")
      .update(updateData)
      .eq("driver_id", driverId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    next(error);
  }
});
app.delete("/api/drivers/:driverId", async (req, res, next) => {
  try {
    const { driverId } = req.params;

    const { error } = await supabase
      .from("driver")
      .delete()
      .eq("driver_id", driverId);

    if (error) throw error;
    res.json({ message: "ลบ Driver สำเร็จ" });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/drivers/:driverId", async (req, res, next) => {
  req.url = `/api/drivers/${req.params.driverId}`;
  req.method = "PUT";
  next();
});
// API ดึงตำแหน่งล่าสุดของไดรเวอร์ทั้งหมด
app.get("/api/driver-locations", async (req, res, next) => {
  try {
    const status = String(req.query.status ?? "").trim();
    const driverId = Number(req.query.driverId || req.query.did || 0);

    let query = supabase
      .from("driver_location")
      .select("location_id, did, latitude, longitude, recorded_at, status")
      .order("recorded_at", { ascending: false });

    if (driverId) query = query.eq("did", driverId);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;

    const latestByDriver = [];
    const seenDriverIds = new Set();
    for (const location of data ?? []) {
      if (seenDriverIds.has(location.did)) continue;
      seenDriverIds.add(location.did);
      latestByDriver.push(location);
    }

    res.json(latestByDriver);
  } catch (error) {
    next(error);
  }
});

// API ดึงตำแหน่งล่าสุดของไดรเวอร์รายคน
app.get("/api/driver-locations/:driverId", async (req, res, next) => {
  try {
    const driverId = Number(req.params.driverId);
    if (!driverId) return res.status(400).json({ error: "driverId is required" });

    const { data, error } = await supabase
      .from("driver_location")
      .select("location_id, did, latitude, longitude, recorded_at, status")
      .eq("did", driverId)
      .order("recorded_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    const location = data?.[0] ?? null;
    if (!location) throw createHttpError(404, "ไม่พบตำแหน่งไดรเวอร์");

    res.json(location);
  } catch (error) {
    next(error);
  }
});


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
        (trackingRows ?? [])
          .flatMap((r) => [r.branch_start, r.branch_end, resolveBranchId(r)])
          .filter((id) => id != null),
      ),
    ];

    let branchMap = {};
    if (branchIds.length > 0) {
      const { data: branchRows, error: branchError } = await supabase
        .from("branch")
        .select("branch_id, name, latitude, longitude, address")
        .in("branch_id", branchIds);

      if (branchError) throw branchError;
      branchMap = Object.fromEntries(
        (branchRows ?? []).map((b) => [b.branch_id, b]),
      );
    }

    const trackingList = (trackingRows ?? []).map((row) => ({
      ...row,
      branch: branchMap[resolveBranchId(row)] ?? null,
      branch_start_detail: branchMap[row.branch_start] ?? null,
      branch_end_detail: branchMap[row.branch_end] ?? null,
    }));

    // ─── เพิ่ม: หาพิกัดผู้รับ ───
    let receiverCoords = null;
    if (shipment.receiver_id) {
  // ลองหา default address ก่อน
        const { data: addrRows } = await supabase
            .from("address")
            .select("latitude, longitude, is_default")
            .eq("user_id", shipment.receiver_id)
            .order("is_default", { ascending: false })  // default first
            .limit(1); 

        const addr = addrRows?.[0];
        if (addr?.latitude && addr?.longitude) {
          receiverCoords = { 
              latitude: addr.latitude, 
              longitude: addr.longitude 
            };
      }
    }

    res.json({ shipment, trackingList, receiver_coords: receiverCoords });
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

// app.post("/api/shipments/confirm", async (req, res, next) => {
//   try {
//     const { senderId, receiverId, requestId, parcelId, parcelWeight, quantity, receiverAddress } = req.body;

//     const senderAddress = await getPrimaryAddress(senderId);
//     const senderDetail = buildAddressText(senderAddress);
//     const trackingNumber = await getUniqueTrackingNumber();
//     const now = new Date();
//     const estimatedDelivery = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

//     const { data: shipmentRows, error: insertShipmentError } = await supabase
//       .from("shipment")
//       .insert({
//         sender_id: senderId,
//         receiver_id: receiverId,
//         receiver_address: receiverAddress,
//         sender_detail: senderDetail,
//         shipping_cost: calculateShippingCost(Number(parcelWeight)),
//         shipment_date: now.toISOString(),
//         estimated_delivery: estimatedDelivery.toISOString(),
//         status: "waiting_driver",
//         tracking_number: trackingNumber,
//         request_id: requestId,
//       })
//       .select();

//     if (insertShipmentError) throw insertShipmentError;

//     const { error: updateParcelError } = await supabase
//       .from("parcels")
//       .update({ quantity })
//       .eq("parcel_id", parcelId);

//     if (updateParcelError) throw updateParcelError;

//     const { error: updateRequestError } = await supabase
//       .from("request")
//       .update({ status: "waiting_driver" })
//       .eq("request_id", requestId);

//     if (updateRequestError) throw updateRequestError;

//     res.status(201).json({ trackingNumber, shipment: shipmentRows?.[0] ?? null });
//   } catch (error) {
//     next(error);
//   }
// });

// ลบ Request
app.delete("/api/request/:requestId", async (req, res, next) => {
  try {
    const { requestId } = req.params;

    // ถ้ามี shipment ผูกกับ request นี้ ให้ลบ shipment ก่อน
    await supabase
      .from("shipment")
      .delete()
      .eq("request_id", requestId);

    const { error } = await supabase
      .from("request")
      .delete()
      .eq("request_id", requestId);

    if (error) throw error;

    res.json({ message: "ลบ Request สำเร็จ" });
  } catch (error) {
    next(error);
  }
});

//แก้ไขrequest
app.put("/api/request/:requestId", async (req, res, next) => {
  try {
    const { requestId } = req.params;

    const {
      type,
      status,
      reason,
      image,
      receiver_id,
      receiver_name,
      receiver_phone,
      receiver_address,
    } = req.body;

    const updateData = {};
    if (type !== undefined) updateData.type = type;
    if (status !== undefined) updateData.status = status;
    if (reason !== undefined) updateData.reason = reason;
    if (image !== undefined) updateData.image = image;
    if (receiver_id !== undefined) updateData.receiver_id = receiver_id;
    if (receiver_name !== undefined) updateData.receiver_name = receiver_name;
    if (receiver_phone !== undefined) updateData.receiver_phone = receiver_phone;
    if (receiver_address !== undefined) updateData.receiver_address = receiver_address;

    const { data, error } = await supabase
      .from("request")
      .update(updateData)
      .eq("request_id", requestId)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    next(error);
  }
});

//เลือกrequest
app.get("/api/requests", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("request")
      .select("*, parcels(*), users(*, address(*)), shipment(shipment_id, tracking_number, status)");

    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch return requests", error: error.message });
  }
});

// อัปโหลดรูปโปรไฟล์ driver
app.post("/api/upload/profile-image", async (req, res, next) => {
  try {
    const { base64, fileName, mimeType } = req.body;
    if (!base64 || !fileName)
      return res.status(400).json({ error: "base64 and fileName are required" });

    const buffer = Buffer.from(base64, "base64");
    const filePath = `profiles/${Date.now()}_${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from("profile-images")          // ← สร้าง bucket นี้ใน Supabase ด้วย (public)
      .upload(filePath, buffer, {
        contentType: mimeType || "image/jpeg",
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from("profile-images")
      .getPublicUrl(filePath);

    res.json({ url: urlData.publicUrl });
  } catch (error) {
    next(error);
  }
});

// บันทึก URL ลงตาราง driver
app.patch("/api/driver/:driverId/profile", async (req, res, next) => {
  try {
    const driverId = Number(req.params.driverId);
    const { profileUrl } = req.body;

    const { data, error } = await supabase
      .from("driver")
      .update({ profile: profileUrl })
      .eq("driver_id", driverId)
      .select("driver_id, name, email, phone, car_plate, wallet, profile")
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    next(error);
  }
});

//ถอนเงิน
app.post("/api/driver/withdraw", async (req, res) => {
  try {
    const { driverId, amount } = req.body;

    const { data: driver } = await supabase
      .from("driver")
      .select("wallet")
      .eq("driver_id", driverId)
      .single();

    if (!driver) {
      return res.status(404).json({
        error: "ไม่พบคนขับ",
      });
    }

    if (Number(driver.wallet) < Number(amount)) {
      return res.status(400).json({
        error: "ยอดเงินไม่พอ",
      });
    }

    const newWallet =
      Number(driver.wallet) - Number(amount);

    await supabase
      .from("driver")
      .update({
        wallet: newWallet,
      })
      .eq("driver_id", driverId);

    await supabase
  .from("wallet_transaction")
  .insert({
    driver_id: driverId,
    amount: amount,
    type: "withdraw",
    status: "completed",
  });

    res.json({
      success: true,
      wallet: newWallet,
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
    });
  }
});

app.get(
  "/api/driver/:driverId/wallet-transactions",
  async (req, res) => {
    const driverId = Number(
      req.params.driverId,
    );

    const { data, error } =
      await supabase
        .from("wallet_transaction")
        .select("*")
        .eq("driver_id", driverId)
        .order("created_at", {
          ascending: false,
        });

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    res.json(data);
  },
);

// upload delivery proof image (เหมือน return-image)
app.post("/api/upload/proof-image", async (req, res, next) => {
  try {
    const { base64, fileName, mimeType } = req.body;

    if (!base64 || !fileName) {
      return res.status(400).json({ error: "base64 and fileName are required" });
    }

    const buffer = Buffer.from(base64, "base64");
    const filePath = `proofs/${Date.now()}_${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from("proof-images")  // ← ตรงนี้ ต้องตรงกับชื่อ bucket ใน Supabase
      .upload(filePath, buffer, {
        contentType: mimeType || "image/jpeg",
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from("proof-images")  // ← และตรงนี้ด้วย
      .getPublicUrl(filePath);

    res.json({ url: urlData.publicUrl });
  } catch (error) {
    next(error);
  }
});

// บันทึก proof record หลังจัดส่งสำเร็จ
app.post("/api/proof", async (req, res, next) => {
  try {
    const { shipmentId, image, note } = req.body;

    if (!shipmentId) {
      return res.status(400).json({ error: "shipmentId is required" });
    }

    const { data, error } = await supabase
      .from("proof")
      .insert({
        shipment_id: Number(shipmentId),
        image: image ?? null,
        note: note ?? null,
        status: "delivered",
        date: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

//อัปเดตstatus received ว่าได้รับสินค้าแล้ว
app.patch("/api/shipments/:shipmentId/received", async (req, res, next) => {
  try {
    const shipmentId = Number(req.params.shipmentId);

    const { data, error } = await supabase
      .from("shipment")
      .update({ status: "received" })
      .eq("shipment_id", shipmentId)
      .select()
      .single();

    if (error) throw error;

    // update request status ด้วย
    if (data.request_id) {
      await supabase
        .from("request")
        .update({ status: "received" })
        .eq("request_id", data.request_id);
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

//รถเข็นดึงพัสดุที่ต้องได้รับ
app.get("/api/shipments/incoming/:userId", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("shipment")
      .select(`
        shipment_id, tracking_number, status,
        receiver_address, sender_detail,
        shipping_cost, shipment_date, estimated_delivery,
        request_id,
        sender:users!shipment_sender_id_fkey(name, phone),
        request(parcel_id, parcels(parcel_id, weight, quantity))
      `)
      .eq("receiver_id", Number(req.params.userId))
      .order("shipment_date", { ascending: false });

    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

// POST /api/driver/location — บันทึกตำแหน่งคนขับ real-time
app.post("/api/driver/location", async (req, res, next) => {
  try {
    const { driverId, latitude, longitude, status = "delivering" } = req.body;
 
    if (!driverId || latitude == null || longitude == null) {
      return res.status(400).json({ error: "driverId, latitude, longitude are required" });
    }
 
    const { error } = await supabase
      .from("driver_location")
      .upsert(
        {
          did: Number(driverId),
          latitude: Number(latitude),
          longitude: Number(longitude),
          status,
          recorded_at: new Date().toISOString(),
        },
        { onConflict: "did" }   // ← upsert ตาม did แทน insert ใหม่
      );
 
    if (error) throw error;
 
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

//upload return image
app.post("/api/upload/return-image", async (req, res, next) => {
  try {
    const { base64, fileName, mimeType } = req.body;

    if (!base64 || !fileName) {
      return res.status(400).json({ error: "base64 and fileName are required" });
    }

    // แปลง base64 → Buffer
    const buffer = Buffer.from(base64, "base64");

    const filePath = `returns/${Date.now()}_${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from("return-images")
      .upload(filePath, buffer, {
        contentType: mimeType || "image/jpeg",
        upsert: false,
      });

    if (uploadError) throw uploadError;

    // ดึง public URL
    const { data: urlData } = supabase.storage
      .from("return-images")
      .getPublicUrl(filePath);

    res.json({ url: urlData.publicUrl });
  } catch (error) {
    next(error);
  }
});

//confirm shipment และหัก wallet พร้อมกัน
app.post("/api/shipments/confirm", async (req, res, next) => {
  try {
    const {
      senderId,
      receiverId,
      requestId,
      parcelId,
      parcelWeight,
      quantity,
      receiverAddress,
    } = req.body;

    // ─────────────────────────────
    // คำนวณค่าส่ง
    // ─────────────────────────────
    const shippingCost = req.body.shippingCost != null
  ? Number(req.body.shippingCost)
  : calculateShippingCost(Number(parcelWeight));;

    // ─────────────────────────────
    // เช็ค wallet ผู้ส่ง
    // ─────────────────────────────
    const senderUser = await getUserById(senderId);

    if (!senderUser) {
      throw createHttpError(404, "ไม่พบผู้ใช้");
    }

    const currentWallet = Number(
      senderUser.wallet || 0,
    );

    if (currentWallet < shippingCost) {
      throw createHttpError(
        400,
        `ยอดเงินใน Wallet ไม่พอ (ค่าส่ง ${shippingCost} บาท)`
      );
    }

    // ─────────────────────────────
    // เตรียมข้อมูล shipment
    // ─────────────────────────────
    const senderAddress = await getPrimaryAddress(
      senderId,
    );

    const senderDetail =
      buildAddressText(senderAddress);

    const trackingNumber =
      await getUniqueTrackingNumber();

    const now = new Date();

    const estimatedDelivery = new Date(
      now.getTime() +
        3 * 24 * 60 * 60 * 1000,
    );

    // ─────────────────────────────
    // หา branch ผู้ส่ง
    // ─────────────────────────────
    const senderProvince =
      senderAddress?.province ?? null;

    let branchStart = null;

    if (senderProvince) {
      const { data: branchStartRows } =
        await supabase
          .from("branch")
          .select("branch_id")
          .ilike(
            "address",
            `%${senderProvince}%`
          )
          .limit(1);

      branchStart =
        branchStartRows?.[0]?.branch_id ??
        null;
    }

    // ─────────────────────────────
    // หา branch ผู้รับ
    // ─────────────────────────────
    const receiverAddressRow =
      await getPrimaryAddress(receiverId);

    const receiverProvince =
      receiverAddressRow?.province ?? null;

    let branchEnd = null;

    if (receiverProvince) {
      const { data: branchEndRows } =
        await supabase
          .from("branch")
          .select("branch_id")
          .ilike(
            "address",
            `%${receiverProvince}%`
          )
          .limit(1);

      branchEnd =
        branchEndRows?.[0]?.branch_id ??
        null;
    }

    // ─────────────────────────────
    // หัก Wallet
    // ─────────────────────────────
    const newWallet =
      currentWallet - shippingCost;

    const { error: walletError } =
      await supabase
        .from("users")
        .update({
          wallet: newWallet,
        })
        .eq("user_id", senderId);

    if (walletError) throw walletError;

    // ─────────────────────────────
    // สร้าง Shipment
    // ─────────────────────────────
    const {
      data: shipmentRows,
      error: insertShipmentError,
    } = await supabase
      .from("shipment")
      .insert({
        sender_id: senderId,
        receiver_id: receiverId,
        receiver_address:
          receiverAddress,
        sender_detail: senderDetail,
        shipping_cost: shippingCost,
        shipment_date: now.toISOString(),
        estimated_delivery:
          estimatedDelivery.toISOString(),
        status: "waiting_driver",
        tracking_number: trackingNumber,
        request_id: requestId,
      })
      .select();

    if (insertShipmentError)
      throw insertShipmentError;

    const newShipment =
      shipmentRows?.[0] ?? null;

    // ─────────────────────────────
    // เพิ่ม payment history
    // ─────────────────────────────
    if (newShipment) {
      const { error: paymentError } =
        await supabase
          .from("payment")
          .insert({
            shipment_id:
              newShipment.shipment_id,
            user_id: senderId,
            amount: shippingCost,
            method: "wallet",
            status: "completed",
          });

      if (paymentError)
        throw paymentError;

      const { error: txError } = await supabase
          .from("wallet_transaction")
          .insert({
            user_id: senderId,
            amount: shippingCost,
            type: "shipping",        // แยกประเภทจาก topup
            status: "completed",
            note: `ค่าจัดส่ง ${newShipment.tracking_number}`,
          });


      if (txError) throw txError;
    }

    // ─────────────────────────────
    // shipment tracking
    // ─────────────────────────────
    if (newShipment) {
      const { error: trackingError } =
        await supabase
          .from("shipment_tracking")
          .insert({
            shipment_id:
              newShipment.shipment_id,
            status: "waiting_driver",
            note: "รอคนขับรับพัสดุ",
            branch_start: branchStart,
            branch_end: branchEnd,
            timestamp: now.toISOString(),
          });

      if (trackingError)
        throw trackingError;
    }

    // ─────────────────────────────
    // update parcel
    // ─────────────────────────────
    const {
      error: updateParcelError,
    } = await supabase
      .from("parcels")
      .update({ quantity })
      .eq("parcel_id", parcelId);

    if (updateParcelError)
      throw updateParcelError;

    // ─────────────────────────────
    // update request
    // ─────────────────────────────
    const {
      error: updateRequestError,
    } = await supabase
      .from("request")
      .update({
        status: "waiting_driver",
      })
      .eq("request_id", requestId);

    if (updateRequestError)
      throw updateRequestError;

    // ─────────────────────────────
    // success
    // ─────────────────────────────
    res.status(201).json({
      trackingNumber,
      shipment: newShipment,
      remainingWallet: newWallet,
    });
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
      // ── geocode address ก่อน insert ──
      const coords = await geocodeAddress(
        address.address_detail,
        address.subdistrict,
        address.district,
        address.province,
        address.zipcode,
      );

      const { error: addressError } = await supabase.from("address").insert({
        user_id: newUser.user_id,
        address_detail: String(address.address_detail ?? "").trim(),
        province: String(address.province ?? "").trim(),
        district: String(address.district ?? "").trim(),
        subdistrict: String(address.subdistrict ?? "").trim(),
        zipcode: String(address.zipcode ?? "").trim(),
        label: String(address.label ?? "บ้าน").trim(),
        is_default: true,
        latitude: coords?.latitude ?? null,   // ← เพิ่ม
        longitude: coords?.longitude ?? null, // ← เพิ่ม
      });

      if (addressError) throw addressError;
    }

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

    if (user?.deleted_at) {
      throw createHttpError(401, "บัญชีนี้ถูกระงับการใช้งาน");
    }

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

    // ── geocode แปลงที่อยู่เป็น lat/lng ──
    const coords = await geocodeAddress(address_detail, subdistrict, district, province, zipcode);

    const { data, error } = await supabase
      .from("address")
      .insert({
        user_id,
        address_detail,
        province,
        district,
        subdistrict,
        zipcode,
        label: label || "บ้าน",
        is_default: false,
        latitude: coords?.latitude ?? null,   // ← เพิ่ม
        longitude: coords?.longitude ?? null, // ← เพิ่ม
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    next(error);
  }
});

//PronptPay Top-up
app.post("/api/wallet/topup", async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: "จำนวนเงินไม่ถูกต้อง",
      });
    }

    // สร้าง transaction
    const { data, error } = await supabase
      .from("wallet_transaction")
      .insert([
        {
          user_id: userId,
          amount,
          type: "topup",
          status: "pending",
        },
      ])
      .select()
      .single();

    if (error) throw error;

    // สร้าง QR PromptPay
    const payload = promptpay("0855275914", {
      amount: Number(amount),
    });

    const qrCode = await QRCode.toDataURL(payload);

    res.json({
      transaction_id: data.transaction_id,
      qr_code: qrCode,
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
    });
  }
});

app.post("/api/wallet/confirm", async (req, res) => {
  try {
    const { transactionId } = req.body;

    const { data: transaction, error } = await supabase
      .from("wallet_transaction")
      .select("*")
      .eq("transaction_id", transactionId)
      .single();

    if (error || !transaction) {
      return res.status(404).json({
        error: "ไม่พบ transaction",
      });
    }

    if (transaction.status === "completed") {
      return res.status(400).json({
        error: "รายการนี้ถูกยืนยันแล้ว",
      });
    }

    // เพิ่มเงินเข้า wallet
    const { data: userData } = await supabase
      .from("users")
      .select("wallet")
      .eq("user_id", transaction.user_id)
      .single();

    const currentWallet = Number(userData.wallet || 0);

    await supabase
      .from("users")
      .update({
        wallet: currentWallet + Number(transaction.amount),
      })
      .eq("user_id", transaction.user_id);

    // update transaction
    await supabase
      .from("wallet_transaction")
      .update({
        status: "completed",
      })
      .eq("transaction_id", transactionId);

    res.json({
      success: true,
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
    });
  }
});

app.patch("/api/addresses/:id", async (req, res, next) => {
  try {
    const {
      address_detail,
      province,
      district,
      subdistrict,
      zipcode,
      label,
      is_default,
    } = req.body;

    // สร้าง payload เฉพาะ field ที่ส่งมา (ไม่ undefined)
    const updatePayload = {};
    if (address_detail !== undefined) updatePayload.address_detail = address_detail;
    if (province !== undefined) updatePayload.province = province;
    if (district !== undefined) updatePayload.district = district;
    if (subdistrict !== undefined) updatePayload.subdistrict = subdistrict;
    if (zipcode !== undefined) updatePayload.zipcode = zipcode;
    if (label !== undefined) updatePayload.label = label;
    if (is_default !== undefined) updatePayload.is_default = is_default;

    // geocode ใหม่ถ้ามีการแก้ field ที่อยู่
    const hasAddressChange = address_detail || province || district || subdistrict || zipcode;
    if (hasAddressChange) {
      const { data: existing } = await supabase
        .from("address")
        .select()
        .eq("address_id", req.params.id)
        .single();

      if (existing) {
        const merged = {
          address_detail: address_detail ?? existing.address_detail,
          subdistrict: subdistrict ?? existing.subdistrict,
          district: district ?? existing.district,
          province: province ?? existing.province,
          zipcode: zipcode ?? existing.zipcode,
        };

        const coords = await geocodeAddress(
          merged.address_detail,
          merged.subdistrict,
          merged.district,
          merged.province,
          merged.zipcode,
        );

        if (coords) {
          updatePayload.latitude = coords.latitude;
          updatePayload.longitude = coords.longitude;
        }
      }
    }

    const { data, error } = await supabase
      .from("address")
      .update(updatePayload) // ← ใช้ updatePayload แทน ...req.body
      .eq("address_id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.status(200).json(data);
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

app.post(
  "/api/auth/reset-password",
  async (req, res, next) => {
    try {
      const { email, newPassword } = req.body;

      if (!email) {
        throw createHttpError(
          400,
          "กรุณากรอกอีเมล"
        );
      }

      if (
        !newPassword ||
        newPassword.length < 6
      ) {
        throw createHttpError(
          400,
          "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"
        );
      }

      const user =
        await getUserByEmail(
          normalizeEmail(email)
        );

      if (!user) {
        throw createHttpError(
          404,
          "ไม่พบผู้ใช้งาน"
        );
      }

      const hashedPassword =
        await bcrypt.hash(
          String(newPassword),
          12
        );

      const { error } =
        await supabase
          .from("users")
          .update({
            password: hashedPassword,
          })
          .eq(
            "user_id",
            user.user_id
          );

      if (error) throw error;

      res.json({
        success: true,
        message:
          "เปลี่ยนรหัสผ่านสำเร็จ",
      });
    } catch (error) {
      next(error);
    }
  }
);

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

// API อนุมัติคำขอและมอบหมายไดรเวอร์
app.post("/api/requests/:requestId/approve", async (req, res) => {
  const requestId = Number(req.params.requestId);
  const driverId = Number(req.body?.driverId);

  if (!requestId || !driverId) {
    return res.status(400).json({
      message: "requestId and driverId are required",
    });
  }

  try {
    // หา shipment_id จาก request_id โดยตรง (วิธีของเวอร์ชันแรก — เสถียรกว่า)
    const { data: shipmentData, error: shipmentFindError } = await supabase
      .from("shipment")
      .select("shipment_id")
      .eq("request_id", requestId)
      .maybeSingle();

    if (shipmentFindError) throw shipmentFindError;

    const shipmentId = shipmentData?.shipment_id;

    if (!shipmentId) {
      return res.status(404).json({
        message: "Shipment not found",
        shipmentId,
        requestId,
      });
    }

    const now = new Date();
    const estimatedDelivery = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    // อัปเดต shipment + ใส่ driverId (เพิ่มมาจากเวอร์ชันที่สอง)
    const { error: shipmentError } = await supabase
      .from("shipment")
      .update({
        driver_id: driverId,
        shipment_date: now.toISOString(),
        estimated_delivery: estimatedDelivery.toISOString(),
        status: "กำลังจัดส่ง",
      })
      .eq("shipment_id", shipmentId);

    if (shipmentError) throw shipmentError;

    // อัปเดต request
    const { error: approveError } = await supabase
      .from("request")
      .update({ status: "approved" })
      .eq("request_id", requestId);

    if (approveError) throw approveError;

    return res.json({ success: true, requestId, shipmentId });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to approve request",
      error: error.message,
    });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// Consignment & Return Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/consignments", async (req, res, next) => {
  try {
    const { userId, weight, width, height, length, quantity = 1, reason = null, image = null, status = "pending", type = "consignment" } = req.body;

    const { data: parcel, error: parcelError } = await supabase
      .from("parcels")
      .insert({ weight, width, height, length, quantity: Number(quantity), status: "pending" })
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
    .limit(1)
    .maybeSingle();

if (!rate) {
  return res.status(404).json({
    error:
      `ไม่พบอัตราค่าส่งสำหรับ ${finalWeight} kg`,
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

// GET /api/requests/branch/:branchId — pending requests ของสาขานั้น
app.get("/api/requests/branch/:branchId", async (req, res, next) => {
  try {
    const branchId = Number(req.params.branchId);

    // หา shipment ที่มี branch_start หรือ branch_end ตรงกับสาขานี้
    const { data: trackingRows, error: trackingError } = await supabase
      .from("shipment_tracking")
      .select("shipment_id")
      .or(`branch_start.eq.${branchId},branch_end.eq.${branchId}`);

    if (trackingError) throw trackingError;

    const shipmentIds = [...new Set((trackingRows ?? []).map((r) => r.shipment_id))];

    // ดึง request_id จาก shipment เหล่านั้น
    let requestIdsFromShipment = [];
    if (shipmentIds.length > 0) {
      const { data: shipmentRows, error: shipmentError } = await supabase
        .from("shipment")
        .select("request_id")
        .in("shipment_id", shipmentIds);

      if (shipmentError) throw shipmentError;
      requestIdsFromShipment = (shipmentRows ?? [])
        .map((s) => s.request_id)
        .filter((id) => id != null);
    }

    // ดึง requests ที่ status = pending และอยู่ใน requestIds
    let query = supabase
      .from("request")
      .select("*, parcels(*), shipment(shipment_id, tracking_number, status)")
      .eq("status", "pending");

    if (requestIdsFromShipment.length > 0) {
      query = query.in("request_id", requestIdsFromShipment);
    } else {
      // ไม่มี shipment tracking ของสาขานี้เลย → return empty
      return res.json([]);
    }

    const { data, error } = await query.order("date", { ascending: false });
    if (error) throw error;

    res.json(data ?? []);
  } catch (error) {
    next(error);
  }
});

// GET /api/shipments/branch/:branchId — shipments ทั้งหมดของสาขานั้น
app.get("/api/shipments/branch/:branchId", async (req, res, next) => {
  try {
    const branchId = Number(req.params.branchId);

    const { data: trackingRows, error: trackingError } = await supabase
      .from("shipment_tracking")
      .select("shipment_id")
      .or(`branch_start.eq.${branchId},branch_end.eq.${branchId}`);

    if (trackingError) throw trackingError;

    const shipmentIds = [...new Set((trackingRows ?? []).map((r) => r.shipment_id))];

    if (shipmentIds.length === 0) return res.json([]);

    const { data, error } = await supabase
      .from("shipment")
      .select()
      .in("shipment_id", shipmentIds)
      .order("shipment_date", { ascending: false });

    if (error) throw error;
    res.json(data ?? []);
  } catch (error) {
    next(error);
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
 
    // ① ดึง shipment พร้อม sender_id, receiver_id
    const { data: shipments, error: shipmentError } = await supabase
      .from("shipment")
      .select(`
        shipment_id, tracking_number, status, receiver_address, sender_detail,
        shipping_cost, shipment_date, estimated_delivery, request_id,
        sender_id, receiver_id, driver_id,
        sender:users!shipment_sender_id_fkey(name, phone),
        receiver:users!shipment_receiver_id_fkey(name, phone),
        request(parcel_id, parcels(weight, width, height, length))
      `)
      .eq("driver_id", driverId)
      .order("shipment_date", { ascending: false });
 
    if (shipmentError) throw shipmentError;
    if (!shipments?.length) return res.json([]);
 
    // ② รวบรวม user_id ที่ต้องการพิกัด (sender + receiver)
    const userIds = [
      ...new Set([
        ...shipments.map((s) => s.sender_id),
        ...shipments.map((s) => s.receiver_id),
      ].filter(Boolean)),
    ];
 
    // ③ ดึง default address (latitude, longitude) ของแต่ละ user
    const { data: addresses, error: addrError } = await supabase
      .from("address")
      .select("user_id, latitude, longitude, is_default")
      .in("user_id", userIds)
      .eq("is_default", true);
 
    if (addrError) throw addrError;
 
    // ④ สร้าง map user_id → { latitude, longitude }
    const coordMap = {};
    for (const addr of addresses ?? []) {
      if (!coordMap[addr.user_id]) {
        coordMap[addr.user_id] = {
          latitude: addr.latitude ?? null,
          longitude: addr.longitude ?? null,
        };
      }
    }
 
    // ⑤ แนบพิกัดเข้ากับแต่ละ shipment
    const result = shipments.map((s) => ({
      ...s,
      sender_coords:   coordMap[s.sender_id]   ?? { latitude: null, longitude: null },
      receiver_coords: coordMap[s.receiver_id] ?? { latitude: null, longitude: null },
    }));
 
    res.json(result);
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
        sender_id, receiver_id, driver_id,
        sender:users!shipment_sender_id_fkey(name, phone),
        receiver:users!shipment_receiver_id_fkey(name, phone),
        request(parcel_id, parcels(weight, width, height, length))
      `)
      .ilike("tracking_number", trackingNumber)
      .limit(1);
 
    if (error) throw error;
 
    const shipment = data?.[0] ?? null;
    if (!shipment) throw createHttpError(404, "ไม่พบพัสดุ");
 
    // ดึงพิกัด sender + receiver
    const userIds = [shipment.sender_id, shipment.receiver_id].filter(Boolean);
    const { data: addresses } = await supabase
      .from("address")
      .select("user_id, latitude, longitude")
      .in("user_id", userIds)
      .eq("is_default", true);
 
    const coordMap = {};
    for (const addr of addresses ?? []) {
      coordMap[addr.user_id] = { latitude: addr.latitude ?? null, longitude: addr.longitude ?? null };
    }
 
    res.json({
      ...shipment,
      sender_coords:   coordMap[shipment.sender_id]   ?? { latitude: null, longitude: null },
      receiver_coords: coordMap[shipment.receiver_id] ?? { latitude: null, longitude: null },
    });
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
        request_id,
        driver_id
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
