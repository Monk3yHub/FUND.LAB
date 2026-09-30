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
  console.log('🚀 เริ่มดึงรายชื่อกองทุนและ Class ทั้งหมดจาก SEC API...');

  const allFundsMap = new Map();
  let nextCursor = '';
  let pageNum = 1;

  do {
    let url = 'https://api.sec.or.th/v2/fund/general-info/profiles?page_size=100';
    if (nextCursor) {
      url += `&next_cursor=${encodeURIComponent(nextCursor)}`;
    }

    console.log(`[รอบที่ ${pageNum}] กำลังดึงข้อมูล...`);

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

      // 🎯 แก้ไขหลัก: เอา fund_class_name ขึ้นก่อน proj_abbr_name 
      // เพื่อไม่ให้ Class ย่อยโดนยุบรวมกัน
      const classCode = item.fund_class_name?.trim() || item.proj_abbr_name?.trim() || item.unique_id?.trim() || `FUND_${pageNum}_${idx}`;
      const projAbbr = item.proj_abbr_name?.trim() || classCode;

      // ต่อชื่อ Class Detail เพิ่มในชื่อกองทุน (ถ้ามี) เช่น "ชนิดไม่จ่ายเงินปันผล"
      let fullName = (item.proj_name_th || item.proj_name_en || projAbbr).trim();
      if (item.fund_class_detail) {
        fullName += ` (${item.fund_class_detail.trim()})`;
      }

      if (!allFundsMap.has(classCode)) {
        allFundsMap.set(classCode, {
          code: classCode,                          // เช่น SCBNK225, SCBNK225D
          proj_id: String(projId).trim(),           // เช่น M0429_2556
          proj_abbr_name: projAbbr,                 // เช่น SCBNKY225
          name: fullName,                           // ชื่อกองทุน + ชนิดกองทุน
          fund_class_name: classCode,              // ชื่อ Class สำหรับใช้เทียบ NAV
          fund_class_detail: item.fund_class_detail || null,
          fund_class_isin_code: item.fund_class_isin_code || null,
          updated_at: new Date().toISOString()
        });
        newCount++;
      }
    });

    console.log(`- รอบที่ ${pageNum}: อ่านได้ ${items.length} รายการ (เพิ่ม Class ใหม่ ${newCount} รายการ)`);

    pageNum++;

    if (items.length === 0 || (nextCursor && nextCursor === prevCursor)) {
      break;
    }

  } while (nextCursor);

  const uniqueFunds = Array.from(allFundsMap.values());
  console.log(`\n📊 สรุป: รวบรวม Class กองทุนทั้งหมดได้ ${uniqueFunds.length} รายการ`);

  if (uniqueFunds.length === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนจาก SEC API');
  }

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

  console.log(`\n🎉 บันทึกรายชื่อ Class กองทุนลง Supabase เรียบร้อยแล้วทั้งหมด ${insertedCount} รายการ!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
