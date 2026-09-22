import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();
const SEC_API_KEY = process.env.SEC_API_KEY?.trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SEC_API_KEY) {
  console.error('กรุณาตั้งค่า environment variables ให้ครบถ้วน');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

async function syncAllFunds() {
  console.log('เริ่มดึงรายชื่อกองทุนทั้งหมดจาก SEC API v2 (แบบรันวนลูปทุกหน้า)...');

  let allItems = [];
  let page = 1;
  let hasMore = true;
  const seenIds = new Set();

  // วนลูปดึงข้อมูลทีละหน้าจนกว่าจะไม่พบข้อมูลใหม่
  while (hasMore && page <= 100) { // กำหนดเพดานป้องกัน Infinite Loop ไว้ที่ 100 หน้า
    const url = `https://api.sec.or.th/v2/fund/general-info/profiles?page=${page}`;
    console.log(`กำลังดึงข้อมูลหน้า ${page}...`);

    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      console.warn(`หน้า ${page} เกิดข้อผิดพลาด ${res.status}: ${errorText.slice(0, 100)}`);
      break;
    }

    const raw = await res.json();
    const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);

    if (items.length === 0) {
      console.log(`หน้า ${page} ไม่พบข้อมูลเพิ่มเติม สิ้นสุดการดึงข้อมูล`);
      break;
    }

    let newCountOnPage = 0;
    for (const item of items) {
      const uniqueId = item.unique_id || item.proj_id;
      if (uniqueId && !seenIds.has(uniqueId)) {
        seenIds.add(uniqueId);
        allItems.push(item);
        newCountOnPage++;
      }
    }

    console.log(`หน้า ${page}: ดึงได้ ${items.length} รายการ (พบรายการใหม่ ${newCountOnPage} รายการ)`);

    // ถ้าหน้านั้นไม่มีรายการใหม่เลย แสดงว่าข้อมูลเริ่มซ้ำ ให้หยุดวนลูป
    if (newCountOnPage === 0) {
      console.log('ไม่พบรายการใหม่เพิ่มแล้ว สิ้นสุดการวนลูป');
      break;
    }

    // ถ้าข้อมูลได้ไม่ถึง 100 แสดงว่าเป็นหน้าสุดท้าย
    if (items.length < 100) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(`\nรวบรวมข้อมูลกองทุนทั้งหมดสำเร็จได้: ${allItems.length} รายการ`);

  if (allItems.length === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนส่งกลับมาจาก SEC API');
  }

  // แปลงข้อมูลเข้าตาราง funds
  const fundsToInsert = allItems.map((item, index) => {
    const projId = item.proj_id || `PROJ_${index}`;
    const code = (item.proj_abbr_name || item.unique_id || item.proj_id)?.trim();
    const name = (item.proj_name_th || item.proj_name_en || code)?.trim();

    return {
      proj_id: String(projId).trim(),
      code: String(code).trim(),
      name: String(name).trim(),
    };
  });

  // กรองเฉพาะรายการที่ไม่ซ้ำตาม code
  const uniqueFundsMap = new Map();
  for (const fund of fundsToInsert) {
    if (fund.code && !uniqueFundsMap.has(fund.code)) {
      uniqueFundsMap.set(fund.code, fund);
    }
  }

  const uniqueFunds = Array.from(uniqueFundsMap.values());
  console.log(`คัดกรองเหลือรหัสกองทุนที่ไม่ซ้ำกัน: ${uniqueFunds.length} รายการ`);

  // บันทึกลง Supabase แบบ Batch Upsert
  const chunkSize = 200;
  let insertedCount = 0;

  for (let i = 0; i < uniqueFunds.length; i += chunkSize) {
    const chunk = uniqueFunds.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('funds')
      .upsert(chunk, { onConflict: 'code' });

    if (error) {
      console.error(`เกิดข้อผิดพลาดในการบันทึกชุดที่ ${i}:`, error.message);
    } else {
      insertedCount += chunk.length;
    }
  }

  console.log(`บันทึกรายชื่อกองทุนทั้งหมดลง Supabase สำเร็จเรียบร้อย ${insertedCount} กองทุน!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
