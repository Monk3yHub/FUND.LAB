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

// ฟังก์ชันยิงขอ NAV ล่าสุดผ่าน proj_id
async function fetchNAVByProjId(projId) {
  try {
    const url = `https://api.sec.or.th/v2/fund/nav/daily?proj_id=${encodeURIComponent(projId)}`;
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.items ?? data.data ?? []);
    if (items.length === 0) return null;

    // ดึงรายการ NAV วันล่าสุด
    const latest = items[0];
    const navVal = parseFloat(latest.net_asset_value || latest.nav || latest.last_val);

    if (isNaN(navVal)) return null;

    return {
      nav_date: latest.nav_date || latest.as_of_date,
      nav: navVal,
    };
  } catch {
    return null;
  }
}

async function updateAllNAV() {
  console.log('1. กำลังดึงรายชื่อกองทุนพร้อม proj_id จากตาราง funds ใน Supabase...');
  
  // ดึงเฉพาะกองทุนที่มี proj_id
  const { data: funds, error } = await supabase
    .from('funds')
    .select('code, proj_id')
    .not('proj_id', 'is', null);

  if (error || !funds || funds.length === 0) {
    throw new Error(`ดึงข้อมูลกองทุนไม่สำเร็จ: ${error?.message}`);
  }

  console.log(`พบกองทุนที่พร้อมดึง NAV ทั้งหมด ${funds.length} รายการ`);

  const navRecords = [];
  const BATCH_SIZE = 15; // รันพร้อมกันครั้งละ 15 requests ป้องกัน Timeout และ Rate Limit

  console.log('\n2. เริ่มดึงข้อมูล NAV จาก SEC API...');

  for (let i = 0; i < funds.length; i += BATCH_SIZE) {
    const chunk = funds.slice(i, i + BATCH_SIZE);
    
    const results = await Promise.all(
      chunk.map(async (fund) => {
        const navData = await fetchNAVByProjId(fund.proj_id);
        if (navData && navData.nav_date) {
          return {
            fund_code: fund.code,
            nav_date: navData.nav_date,
            nav: navData.nav,
          };
        }
        return null;
      })
    );

    const validNavs = results.filter(Boolean);
    navRecords.push(...validNavs);

    if ((i + BATCH_SIZE) % 300 === 0 || i + BATCH_SIZE >= funds.length) {
      console.log(`- ประมวลผลแล้ว ${Math.min(i + BATCH_SIZE, funds.length)} / ${funds.length} กองทุน (พบ NAV ที่มีข้อมูล ${navRecords.length} รายการ)`);
    }
  }

  console.log(`\nรวบรวม NAV สำเร็จทั้งหมด ${navRecords.length} รายการ`);

  if (navRecords.length === 0) {
    console.log('ไม่พบข้อมูล NAV ที่ต้องบันทึก');
    return;
  }

  // 3. บันทึกลงตาราง nav_history
  console.log('\n3. บันทึกข้อมูลลงตาราง nav_history บน Supabase...');
  const INSERT_CHUNK = 200;
  let savedCount = 0;

  for (let i = 0; i < navRecords.length; i += INSERT_CHUNK) {
    const chunk = navRecords.slice(i, i + INSERT_CHUNK);
    const { error: insertError } = await supabase
      .from('nav_history')
      .upsert(chunk, { onConflict: 'fund_code,nav_date' });

    if (insertError) {
      console.error(`เกิดข้อผิดพลาดชุดที่ ${i}:`, insertError.message);
    } else {
      savedCount += chunk.length;
    }
  }

  console.log(`บันทึก NAV ลง Supabase เรียบร้อยแล้วทั้งหมด ${savedCount} รายการ!`);
}

updateAllNAV().catch((err) => {
  console.error('Update NAV Failed:', err?.message ?? err);
  process.exit(1);
});
