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
  console.log('กำลังดึงรายชื่อกองทุนทั้งหมดจาก SEC API v2 (daily-info/nav)...');

  // ดึงจาก daily-info/nav เพื่อรับรายชื่อกองทุนแอคทีฟทั้งหมดในครั้งเดียว
  const url = 'https://api.sec.or.th/v2/fund/daily-info/nav';

  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`SEC API Error status: ${res.status} - ${errorText.slice(0, 150)}`);
  }

  const raw = await res.json();
  const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);

  console.log(`พบข้อมูลจาก SEC API ทั้งหมด ${items.length} รายการ`);

  if (items.length === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนส่งกลับมาจาก SEC API');
  }

  // แปลงข้อมูลให้อยู่ในโครงสร้างตาราง funds (code, proj_id, name)
  const fundsToInsert = items
    .map((item) => {
      const projId = item.proj_id;
      const code = (item.unique_id || item.proj_abbr_name || item.proj_id)?.trim();
      const name = (item.proj_name_th || item.proj_name_en || code)?.trim();

      return {
        proj_id: projId,
        code: code,
        name: name,
      };
    })
    .filter((f) => f.proj_id && f.code && f.name);

  // ลบรายการที่ code ซ้ำกัน
  const uniqueFunds = Array.from(
    new Map(fundsToInsert.map((f) => [f.code, f])).values()
  );

  console.log(`กำลังบันทึกกองทุนจำนวน ${uniqueFunds.length} รายการ ลง Supabase...`);

  const chunkSize = 200;
  let insertedCount = 0;

  for (let i = 0; i < uniqueFunds.length; i += chunkSize) {
    const chunk = uniqueFunds.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('funds')
      .upsert(chunk, { onConflict: 'code' });

    if (error) {
      console.error(`เกิดข้อผิดพลาดชุดที่ ${i}:`, error.message);
    } else {
      insertedCount += chunk.length;
    }
  }

  console.log(`บันทึกรายชื่อกองทุนเรียบร้อยแล้วทั้งหมด ${insertedCount} กองทุน!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
