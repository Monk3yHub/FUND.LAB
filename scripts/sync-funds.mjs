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

// รายชื่อรหัส บลจ. (AMC ID) หลักในประเทศไทย
const AMC_IDS = [
  'C0000000021', // กสิกรไทย (KAsset)
  'C0000000023', // ไทยพาณิชย์ (SCBAM)
  'C0000000025', // บัวหลวง (BBLAM)
  'C0000000020', // กรุงศรี (KSAM)
  'C0000000007', // กรุงไทย (KTAM)
  'C0000000001', // ทหารไทยธนชาต (ttb)
  'C0000000018', // ยูโอบี (UOBAM)
  'C0000000022', // พรินซิเพิล (Principal)
  'C0000000012', // วรรณ (ONEAM)
  'C0000000009', // แลนด์ แอนด์ เฮ้าส์ (LHAM)
  'C0000000028', // อีสท์สปริง (Eastspring)
  'C0000000002', // แอสเซท พลัส (Asset Plus)
  'C0000000015', // ดาโอ (DAOL)
  'C0000000026', // ทิสโก้ (TISCO)
  'C0000000008', // เกียรตินาคินภัทร (KKP)
  'C0000000019', // ฟิลลิป (Phillip)
  'C0000000004', // เอ็มเอฟซี / เมอร์ชั่น (MFC)
];

async function syncAllFunds() {
  console.log('เริ่มดึงรายชื่อกองทุนแยกตาม บลจ. จาก SEC API v2...');

  const allFundsMap = new Map();

  for (const amcId of AMC_IDS) {
    try {
      const url = `https://api.sec.or.th/v2/fund/general-info/profiles?amc_id=${amcId}`;
      const res = await fetch(url, {
        headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
      });

      if (!res.ok) {
        console.warn(`ดึงข้อมูล บลจ. ${amcId} ไม่สำเร็จ Status: ${res.status}`);
        continue;
      }

      const raw = await res.json();
      const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);

      let count = 0;
      items.forEach((item, idx) => {
        const projId = item.proj_id || item.proj_code || item.unique_id;
        if (!projId) return;

        const rawCode = item.proj_abbr_name || item.unique_id || item.proj_id || item.sym_code || `FUND_${amcId}_${idx}`;
        const code = String(rawCode).trim();
        const rawName = item.proj_name_th || item.proj_name_en || item.proj_abbr_name || code;
        const name = String(rawName).trim();

        if (!allFundsMap.has(code)) {
          allFundsMap.set(code, {
            proj_id: String(projId).trim(),
            code: code,
            name: name,
          });
          count++;
        }
      });

      console.log(`บลจ. ${amcId}: ดึงเพิ่มได้ ${count} กองทุน`);
    } catch (err) {
      console.error(`เกิดข้อผิดพลาดในการดึง บลจ. ${amcId}:`, err.message);
    }
  }

  const uniqueFunds = Array.from(allFundsMap.values());
  console.log(`\nรวบรวมกองทุนทั้งหมดได้รวม: ${uniqueFunds.length} รายการ`);

  if (uniqueFunds.length === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนจาก SEC API');
  }

  // บันทึกลง Supabase แบบ Batch Insert
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

  console.log(`บันทึกรายชื่อกองทุนลง Supabase สำเร็จทั้งหมด ${insertedCount} กองทุน!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
