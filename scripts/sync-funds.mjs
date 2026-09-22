import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (() => {
  const raw = process.env.SUPABASE_URL?.trim();
  if (!raw) return raw;
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
})();
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
  console.log('กำลังดึงรายชื่อกองทุนทั้งหมดจาก SEC API...');

  // Endpoint ดึงรายชื่อกองทุนทั้งหมดของ SEC API v2
  const url = 'https://api.sec.or.th/v2/fund/daily-info/fund';

  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`SEC API Error status: ${res.status}`);
  }

  const raw = await res.json();
  const items = raw.items ?? (Array.isArray(raw) ? raw : []);
  console.log(`พบกองทุนในระบบ SEC ทั้งหมด ${items.length} รายการ`);

  // แปลงข้อมูลให้อยู่ในโครงสร้างตาราง funds (code, proj_id, name)
  const fundsToInsert = items
    .filter((item) => item.proj_id && (item.proj_name_th || item.unique_id))
    .map((item) => ({
      proj_id: item.proj_id,
      code: item.unique_id || item.proj_id, // หรือใช้ชื่อย่อกองทุน
      name: item.proj_name_th || item.proj_name_en || 'กองทุนรวม',
    }));

  // บันทึกลง Supabase ทีละ 200 รายการ (Batch Insert)
  const chunkSize = 200;
  let insertedCount = 0;

  for (let i = 0; i < fundsToInsert.length; i += chunkSize) {
    const chunk = fundsToInsert.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('funds')
      .upsert(chunk, { onConflict: 'proj_id' });

    if (error) {
      console.error(`เกิดข้อผิดพลาดในชุดที่ ${i}:`, error.message);
    } else {
      insertedCount += chunk.length;
      console.log(`บันทึกแล้ว ${insertedCount} / ${fundsToInsert.length} กองทุน`);
    }
  }

  console.log(' Sync รายชื่อกองทุนจาก SEC เรียบร้อยแล้ว!');
}

syncAllFunds().catch(console.error);
