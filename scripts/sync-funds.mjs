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
  console.log('กำลังดึงรายชื่อกองทุนจาก SEC API...');

  let allItems = [];
  
  // 1. ดึงข้อมูลหน้าแรก
  const baseUrl = 'https://api.sec.or.th/v2/fund/general-info/profiles';
  const res = await fetch(baseUrl, {
    headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`SEC API Error status: ${res.status} - ${errorText.slice(0, 150)}`);
  }

  const raw = await res.json();
  const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);
  allItems = items;

  console.log(`ดึงข้อมูลตั้งต้นได้ ${allItems.length} รายการจาก SEC API`);

  if (allItems.length === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนส่งกลับมาจาก SEC API');
  }

  // พิมพ์โครงสร้างข้อมูลตัวอย่างใน Log เพื่อให้ตรวจสอบย้อนหลังได้ง่าย
  console.log('ตัวอย่างโครงสร้างข้อมูลจาก SEC:', JSON.stringify(allItems[0]));

  // 2. แปลงข้อมูลและป้องกันค่า undefined ไม่ให้ข้อมูลซ้ำจนถูกลบเหลือ 1 รายการ
  const fundsToInsert = allItems.map((item, index) => {
    const projId = item.proj_id || item.proj_code || `PROJ_${index}`;
    
    // ดึงรหัสกองทุน โดยไล่ตามลำดับฟิลด์ที่มีโอกาสเกิดขึ้นได้
    const rawCode = item.proj_abbr_name || item.unique_id || item.sym_code || item.proj_id || item.proj_code;
    const code = rawCode ? String(rawCode).trim() : `FUND_${projId}`;

    // ดึงชื่อกองทุน
    const rawName = item.proj_name_th || item.proj_name_en || item.proj_abbr_name || code;
    const name = String(rawName).trim();

    return {
      proj_id: String(projId).trim(),
      code: code,
      name: name,
    };
  });

  // 3. กรองเฉพาะรายการที่ไม่ซ้ำตาม code
  const uniqueFundsMap = new Map();
  for (const fund of fundsToInsert) {
    if (fund.code && !uniqueFundsMap.has(fund.code)) {
      uniqueFundsMap.set(fund.code, fund);
    }
  }

  const uniqueFunds = Array.from(uniqueFundsMap.values());
  console.log(`คัดกรองได้กองทุนที่ไม่ซ้ำกันจำนวนทั้งหมด ${uniqueFunds.length} รายการ`);

  // 4. บันทึกลง Supabase แบบ Batch Insert
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

  console.log(`บันทึกสำเร็จลง Supabase ทั้งหมด ${insertedCount} กองทุน!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
