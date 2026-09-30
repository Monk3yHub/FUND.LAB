import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();
const SEC_API_KEY = process.env.SEC_API_KEY?.trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SEC_API_KEY) {
  console.error('❌ กรุณาตั้งค่า SUPABASE_URL, SUPABASE_SERVICE_KEY และ SEC_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

async function syncAllFunds() {
  console.log('🚀 เริ่มต้น Sync รายชื่อกองทุนและ Class เข้าตาราง funds...');

  const allFundsMap = new Map();
  let nextCursor = '';
  let pageNum = 1;

  do {
    let url = 'https://api.sec.or.th/v2/fund/general-info/profiles?page_size=100';
    if (nextCursor) {
      url += `&next_cursor=${encodeURIComponent(nextCursor)}`;
    }

    console.log(`[รอบที่ ${pageNum}] กำลังดึงข้อมูลจาก SEC API...`);

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

      // 1. ดึงรหัส Class / กองทุน (เอา fund_class_name ขึ้นก่อน)
      const classCode = (
        item.fund_class_name || 
        item.proj_abbr_name || 
        item.unique_id || 
        `FUND_${pageNum}_${idx}`
      ).trim();

      // 2. ชื่อกองทุน (หากมีรายละเอียด Class ให้ต่อท้าย)
      let rawName = (item.proj_name_th || item.proj_name_en || item.proj_abbr_name || classCode).trim();
      if (item.fund_class_detail && item.fund_class_detail.trim()) {
        rawName += ` (${item.fund_class_detail.trim()})`;
      }

      if (!allFundsMap.has(classCode)) {
        // 🎯 แมปเฉพาะคอลัมน์ที่มีอยู่จริงในตาราง funds (ตามรูปภาพ)
        allFundsMap.set(classCode, {
          code: classCode,
          proj_id: String(projId).trim(),
          name: rawName,
          fund_class_name: classCode // จะไปเติมค่าในคอลัมน์ fund_class_name ที่เคยเป็น NULL
        });
        newCount++;
      }
    });

    console.log(`- รอบที่ ${pageNum}: ดึงได้ ${items.length} รายการ (สะสมรายการใหม่ ${newCount} รายการ)`);
    pageNum++;

    if (items.length === 0 || (nextCursor && nextCursor === prevCursor)) {
      break;
    }

  } while (nextCursor);

  const uniqueFunds = Array.from(allFundsMap.values());
  console.log(`\n📊 สรุป: รวบรวมข้อมูลกองทุน/Class ทั้งหมดได้ ${uniqueFunds.length} รายการ`);

  if (uniqueFunds.length === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนจาก SEC API');
  }

  // บันทึกลง Supabase
  const chunkSize = 200;
  let insertedCount = 0;

  for (let i = 0; i < uniqueFunds.length; i += chunkSize) {
    const chunk = uniqueFunds.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('funds')
      .upsert(chunk, { onConflict: 'code' });

    if (error) {
      console.error(`❌ เกิดข้อผิดพลาดในการบันทึกชุดที่ ${i}:`, error.message);
    } else {
      insertedCount += chunk.length;
    }
  }

  console.log(`\n🎉 บันทึกข้อมูลลงตาราง funds สำเร็จทั้งหมด ${insertedCount} รายการ!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
