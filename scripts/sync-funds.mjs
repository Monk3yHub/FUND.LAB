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
  console.log('กำลังดึงรายชื่อกองทุนจาก SEC API v2...');

  // ห้ามใส่ query parameter เช่น ?page=1 เพราะ SEC API v2 จะตอบกลับเป็น Error 400
  const url = 'https://api.sec.or.th/v2/fund/general-info/profiles';

  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`SEC API Error status: ${res.status} - ${errorText.slice(0, 150)}`);
  }

  const raw = await res.json();
  const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);

  console.log(`พบข้อมูลตั้งต้นจาก SEC API ทั้งหมด ${items.length} รายการ`);

  if (items.length === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนส่งกลับมาจาก SEC API');
  }

  // แปลงข้อมูลและกำหนด Fallback ป้องกันค่า undefined ซ้ำกันจนถูกยุบเหลือ 1 รายการ
  const uniqueFundsMap = new Map();

  items.forEach((item, idx) => {
    const projId = item.proj_id || item.proj_code || item.unique_id;
    if (!projId) return;

    const rawCode = item.proj_abbr_name || item.unique_id || item.proj_id || item.sym_code || `FUND_${idx}`;
    const code = String(rawCode).trim();
    
    const rawName = item.proj_name_th || item.proj_name_en || item.proj_abbr_name || code;
    const name = String(rawName).trim();

    if (!uniqueFundsMap.has(code)) {
      uniqueFundsMap.set(code, {
        proj_id: String(projId).trim(),
        code: code,
        name: name,
      });
    }
  });

  const uniqueFunds = Array.from(uniqueFundsMap.values());
  console.log(`คัดกรองรายชื่อกองทุนพร้อมบันทึกจำนวน ${uniqueFunds.length} รายการ...`);

  // บันทึกลง Supabase แบบ Batch Insert (ครั้งละ 200 รายการ)
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

  console.log(`บันทึกรายชื่อกองทุนลง Supabase เรียบร้อยแล้วทั้งหมด ${insertedCount} กองทุน!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
