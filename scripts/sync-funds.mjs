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
  console.log('เริ่มดึงรายชื่อกองทุนทั้งหมดจาก SEC API ด้วย Cursor Pagination...');

  const allFundsMap = new Map();
  let nextCursor = '';
  let pageNum = 1;

  do {
    let url = 'https://api.sec.or.th/v2/fund/general-info/profiles?page_size=100';
    if (nextCursor) {
      url += `&next_cursor=${encodeURIComponent(nextCursor)}`;
    }

    console.log(`[รอบที่ ${pageNum}] กำลังดึงข้อมูลกองทุน...`);

    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`SEC API Error status: ${res.status} - ${errText.slice(0, 150)}`);
    }

    const raw = await res.json();
    const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);

    const nextCursorFromBody = raw.next_cursor || raw.nextCursor;
    const nextCursorFromHeader = res.headers.get('x-next-cursor') || res.headers.get('next-cursor') || res.headers.get('next_cursor');
    
    const prevCursor = nextCursor;
    nextCursor = nextCursorFromBody || nextCursorFromHeader || '';

    let newCount = 0;
    items.forEach((item, idx) => {
      const projId = item.proj_id || item.proj_code || item.unique_id;
      if (!projId) return;

      const rawCode = item.proj_abbr_name || item.unique_id || item.proj_id || item.sym_code || `FUND_${pageNum}_${idx}`;
      const code = String(rawCode).trim();
      const rawName = item.proj_name_th || item.proj_name_en || item.proj_abbr_name || code;
      const name = String(rawName).trim();

      if (!allFundsMap.has(code)) {
        allFundsMap.set(code, {
          proj_id: String(projId).trim(),
          code: code,
          name: name,
          fund_class_name: code, // 👈 เพิ่มบรรทัดนี้: บันทึก Class Name ให้ตรงกับ code ของ Class นั้นๆ
          updated_at: new Date().toISOString()
        });
        newCount++;
      }
    });

    console.log(`- รอบที่ ${pageNum}: ดึงได้ ${items.length} รายการ (สะสมกองทุนใหม่ ${newCount} กองทุน)`);

    pageNum++;

    if (items.length === 0 || (nextCursor && nextCursor === prevCursor)) {
      break;
    }

  } while (nextCursor);

  const uniqueFunds = Array.from(allFundsMap.values());
  console.log(`\nสรุป: รวบรวมกองทุนและ Class ทั้งหมดได้รวม ${uniqueFunds.length} รายการ`);

  if (uniqueFunds.length === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนจาก SEC API');
  }

  // บันทึกลง Supabase แบบ Batch Insert / Upsert
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

  console.log(`\nบันทึกรายชื่อกองทุนลง Supabase เรียบร้อยแล้วทั้งหมด ${insertedCount} กองทุน!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
