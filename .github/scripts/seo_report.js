'use strict';

const { google } = require('googleapis');
const https = require('https');
const nodemailer = require('nodemailer');

const CLIENT_ID       = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET   = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN   = process.env.GOOGLE_REFRESH_TOKEN;
const GSC_SITE_URL    = process.env.GSC_SITE_URL;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const [REPO_OWNER, REPO_NAME] = (process.env.GITHUB_REPOSITORY || '/').split('/');

// SEOレポートの数値（セッション・クリック・アフィリエイトのクリック数・流入元など）は、
// 公開リポジトリのIssueに残すと誰でも閲覧できる。運営数値を公開しない方針のため、
// 既定ではIssueを作成せずメール通知のみとする。
// 再びIssueにも残したい場合は、ワークフローの env に CREATE_ISSUE: 'true' を追加する。
const CREATE_ISSUE = process.env.CREATE_ISSUE === 'true';

// ---- 目標値 ----
// アフィリエイト訴求の表示用ラベル（app.js の PROMOS / data-placement と対応）
const PROMO_LABEL = {
  music:  'オルコネ（音楽教室）',
  course: '四谷学院（通信講座）',
  career: '転職サービス',
};
const PLACEMENT_LABEL = {
  top:      'トップページ',
  jisshu:   '保育実習理論ページ',
  result:   'クイズ結果画面',
  jitsugi:  '実技試験ページ',
  dokugaku: '独学ガイドページ',
};

// 科目名 → 科目ページのディレクトリ名。
// 「その科目のクエリを、科目ページとトップページのどちらが受けているか」を
// 判定するために使う（カニバリゼーションの検出）。
const SUBJECT_PAGES = {
  '保育原理':         'hoiku-genri',
  '教育原理':         'kyoiku-genri',
  '社会福祉':         'shakai-fukushi',
  '子ども家庭福祉':   'kodomo-katei-fukushi',
  '社会的養護':       'shakaiteki-yogo',
  '保育の心理学':     'hoiku-shinrigaku',
  '子どもの保健':     'kodomo-hoken',
  '子どもの食と栄養': 'shokuji-eiyou',
  '保育実習理論':     'jisshu-riron',
};

const TARGETS = {
  // 直前期目標（2026年10月31日）
  // 9/9時点で表示504・クリック104・セッション306・平均4.5位。
  // 10月は年間最大の山で、キーワードプランナーの実測では主力クエリ
  // 「保育士試験 一問一答」が9月210→10月260（+24%）に伸びる。
  // 季節係数1.24に、科目ページの順位改善が続く分を上乗せして約1.4倍で設定した。
  // 平均順位は表示回数が増えるほど下がりやすいため、改善ではなく維持を目標とする。
  short: {
    label: '直前期目標',
    deadline: '2026年10月31日',
    impressions: 700,
    clicks: 140,
    position: 5.0,
    sessions: 400,
  },
  // 中期目標（2026年9月30日）は 9/9 時点で全項目達成済み。
  // 期限まで達成状況を表示し続けるため、値はそのまま残している。
  mid: {
    label: '中期目標',
    deadline: '2026年9月30日',
    impressions: 500,
    clicks: 50,
    organicSessions: 30,
  },
};

// 秒数を m:ss に整形する。先に四捨五入しないと 239.7秒 が「3:60」になる。
function fmtDuration(sec) {
  if (isNaN(sec)) return '–';
  const t = Math.round(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function diffLabel(current, prev) {
  if (prev === 0 && current === 0) return '–';
  if (prev === 0) return `▲${current}`;
  const diff = current - prev;
  const pct = Math.round(diff / prev * 100);
  if (diff > 0) return `▲${diff} (+${pct}%)`;
  if (diff < 0) return `▼${Math.abs(diff)} (${pct}%)`;
  return `→0 (0%)`;
}

function shortUrl(url) {
  return url.replace(/^https?:\/\/[^/]+/, '') || '/';
}

function goalStatus(current, target, lowerIsBetter = false) {
  if (!target) return { pct: '–', icon: '–' };
  const ratio = lowerIsBetter
    ? (current > 0 ? target / current : 0)
    : (target > 0 ? current / target : 0);
  const achieved = lowerIsBetter ? current <= target : current >= target;
  const pct = achieved ? '✅ 達成' : `${Math.min(Math.round(ratio * 100), 99)}%`;
  const icon = achieved ? '🟢' : ratio >= 0.5 ? '🟡' : '🔴';
  return { pct, icon };
}

async function fetchGSCTotals(auth, startDate, endDate) {
  const webmasters = google.webmasters({ version: 'v3', auth });
  try {
    const res = await webmasters.searchanalytics.query({
      siteUrl: GSC_SITE_URL,
      requestBody: {
        startDate,
        endDate,
        // dimensionsなし = プライバシーフィルタを受けない正確な合計値
      },
    });
    const row = (res.data.rows || [])[0];
    return row
      ? { impressions: row.impressions, clicks: row.clicks, ctr: row.ctr, position: row.position }
      : { impressions: 0, clicks: 0, ctr: 0, position: 0 };
  } catch (e) {
    console.error('GSC totals error:', e.message);
    return { impressions: 0, clicks: 0, ctr: 0, position: 0 };
  }
}

async function fetchGSCByQuery(auth, startDate, endDate) {
  const webmasters = google.webmasters({ version: 'v3', auth });
  try {
    const res = await webmasters.searchanalytics.query({
      siteUrl: GSC_SITE_URL,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit: 100,
      },
    });
    return res.data.rows || [];
  } catch (e) {
    console.error('GSC query error:', e.message);
    return [];
  }
}

async function fetchGSCByPage(auth, startDate, endDate) {
  const webmasters = google.webmasters({ version: 'v3', auth });
  try {
    const res = await webmasters.searchanalytics.query({
      siteUrl: GSC_SITE_URL,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['page'],
        rowLimit: 25,
      },
    });
    return res.data.rows || [];
  } catch (e) {
    console.error('GSC page error:', e.message);
    return [];
  }
}

// クエリとページの組み合わせを取得する。
// クエリ単体・ページ単体の集計では「どのクエリでどのページが出たか」が分からず、
// 科目ページとトップページの食い合いを判定できないため別途取得する。
async function fetchGSCByQueryPage(auth, startDate, endDate) {
  const webmasters = google.webmasters({ version: 'v3', auth });
  try {
    const res = await webmasters.searchanalytics.query({
      siteUrl: GSC_SITE_URL,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query', 'page'],
        rowLimit: 250,
      },
    });
    return res.data.rows || [];
  } catch (e) {
    console.error('GSC query x page error:', e.message);
    return [];
  }
}

async function fetchGA4(auth, startDate, endDate) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });
  try {
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'engagementRate' },
        ],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      },
    });
    const channelMap = {
      'Organic Search': '検索',
      'Organic Social': 'SNS',
      'Direct': 'ダイレクト',
      'Referral': '参照',
      'Unassigned': 'その他',
    };
    const rows = (res.data.rows || []).map(r => ({
      channel: channelMap[r.dimensionValues[0].value] || r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      pageviews: parseInt(r.metricValues[1].value),
      bounceRate: parseFloat(r.metricValues[2].value),
      avgDuration: parseFloat(r.metricValues[3].value),
      engagementRate: parseFloat(r.metricValues[4].value),
    })).sort((a, b) => b.sessions - a.sessions);
    return rows;
  } catch (e) {
    console.error('GA4 error:', e.message);
    return [];
  }
}

async function fetchGA4ByPage(auth, startDate, endDate) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });
  try {
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'engagementRate' },
        ],
        dimensions: [{ name: 'pagePath' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        // 新設ページはセッションが少なく、上位10件では落ちてしまうため広めに取る
        limit: 20,
      },
    });
    return (res.data.rows || []).map(r => ({
      path: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      pageviews: parseInt(r.metricValues[1].value),
      bounceRate: parseFloat(r.metricValues[2].value),
      avgDuration: parseFloat(r.metricValues[3].value),
      engagementRate: parseFloat(r.metricValues[4].value),
    }));
  } catch (e) {
    console.error('GA4 page error:', e.message);
    return [];
  }
}

async function fetchGA4ByDevice(auth, startDate, endDate) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });
  try {
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [{ name: 'sessions' }],
        dimensions: [{ name: 'deviceCategory' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      },
    });
    const deviceMap = { mobile: 'スマホ', desktop: 'PC', tablet: 'タブレット' };
    return (res.data.rows || []).map(r => ({
      device: deviceMap[r.dimensionValues[0].value] || r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
    }));
  } catch (e) {
    console.error('GA4 device error:', e.message);
    return [];
  }
}

// アフィリエイト訴求のクリック実績（収益化の唯一の指標）
async function fetchGA4Affiliate(auth, startDate, endDate) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });
  try {
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [{ name: 'eventCount' }],
        dimensions: [
          { name: 'customEvent:promo_id' },
          { name: 'customEvent:placement' },
        ],
        dimensionFilter: {
          filter: { fieldName: 'eventName', stringFilter: { value: 'affiliate_click' } },
        },
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      },
    });
    return (res.data.rows || []).map(r => ({
      promo: r.dimensionValues[0].value,
      placement: r.dimensionValues[1].value,
      clicks: parseInt(r.metricValues[0].value),
    }));
  } catch (e) {
    // カスタムディメンション未登録時もここに来る
    console.error('GA4 affiliate error:', e.message);
    return [];
  }
}

// 新規とリピーターの比率（反復利用がこのサイトの強みのため）
async function fetchGA4NewVsReturning(auth, startDate, endDate) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });
  try {
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' },
          { name: 'engagementRate' },
          { name: 'averageSessionDuration' },
        ],
        dimensions: [{ name: 'newVsReturning' }],
      },
    });
    const label = { new: '新規', returning: 'リピーター' };
    return (res.data.rows || []).map(r => ({
      type: label[r.dimensionValues[0].value] || (r.dimensionValues[0].value || '(未設定)'),
      sessions: parseInt(r.metricValues[0].value),
      engagementRate: parseFloat(r.metricValues[1].value),
      avgDuration: parseFloat(r.metricValues[2].value),
    }));
  } catch (e) {
    console.error('GA4 newVsReturning error:', e.message);
    return [];
  }
}

// ランディングページ別（既存のページ別は経由も含むため、着地点が分からない）
async function fetchGA4Landing(auth, startDate, endDate) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });
  try {
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' },
          { name: 'bounceRate' },
          { name: 'engagementRate' },
        ],
        dimensions: [{ name: 'landingPage' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 20,
      },
    });
    return (res.data.rows || []).map(r => ({
      path: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      bounceRate: parseFloat(r.metricValues[1].value),
      engagementRate: parseFloat(r.metricValues[2].value),
    }));
  } catch (e) {
    console.error('GA4 landing error:', e.message);
    return [];
  }
}

// 参照元/メディアの内訳（「その他」チャネルの正体を特定するため）
async function fetchGA4Source(auth, startDate, endDate) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });
  try {
    const res = await analyticsdata.properties.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' },
          { name: 'engagementRate' },
        ],
        dimensions: [
          { name: 'sessionSourceMedium' },
          { name: 'sessionDefaultChannelGroup' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 15,
      },
    });
    return (res.data.rows || []).map(r => ({
      sourceMedium: r.dimensionValues[0].value,
      channel: r.dimensionValues[1].value,
      sessions: parseInt(r.metricValues[0].value),
      engagementRate: parseFloat(r.metricValues[1].value),
    }));
  } catch (e) {
    console.error('GA4 source error:', e.message);
    return [];
  }
}

function createIssue(title, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ title, body });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO_OWNER}/${REPO_NAME}/issues`,
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'hoikushi-quiz-seo-bot',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 201) resolve();
        else reject(new Error(`GitHub API ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendEmail(reportData, issueBody) {
  const { today, curr, prev, ga4Rows, ga4PageRows, ga4DeviceRows, topPages, lowCtr, opportunity, goals, organicSessions,
          affiliateRows, prevAffiliateRows, newReturnRows, landingRows, sourceRows,
          subjectQueryRows, competingQueries } = reportData;

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.NOTIFY_GMAIL_USER,
      pass: process.env.NOTIFY_GMAIL_APP_PASSWORD,
    },
  });

  const td = (v) => `<td style="padding:4px 8px;text-align:right;">${v}</td>`;
  const th = (v) => `<th style="padding:4px 8px;">${v}</th>`;
  const tdl = (v) => `<td style="padding:4px 8px;">${v}</td>`;

  const summaryHtml = `
    <tr>${tdl('表示回数（GSC）')}${td(curr.impressions)}${td(prev.impressions)}${td(diffLabel(curr.impressions, prev.impressions))}</tr>
    <tr>${tdl('クリック数（GSC）')}${td(curr.clicks)}${td(prev.clicks)}${td(diffLabel(curr.clicks, prev.clicks))}</tr>
    <tr>${tdl('平均CTR')}${td(curr.ctr + '%')}${td(prev.ctr + '%')}${td('–')}</tr>
    <tr>${tdl('平均順位')}${td(curr.position + '位')}${td(prev.position + '位')}${td('–')}</tr>
    <tr style="background:#f0f8ff;">${tdl('セッション（GA4）')}${td(curr.sessions)}${td(prev.sessions)}${td(diffLabel(curr.sessions, prev.sessions))}</tr>
    <tr style="background:#f0f8ff;">${tdl('ページビュー（GA4）')}${td(curr.pageviews)}${td(prev.pageviews)}${td(diffLabel(curr.pageviews, prev.pageviews))}</tr>`;

  const affTotalMail = affiliateRows.reduce((s, r) => s + r.clicks, 0);
  const prevAffTotalMail = prevAffiliateRows.reduce((s, r) => s + r.clicks, 0);
  const affiliateHtml = affiliateRows.length > 0
    ? affiliateRows.map(r =>
        `<tr>${tdl(PROMO_LABEL[r.promo] || r.promo)}${tdl(PLACEMENT_LABEL[r.placement] || r.placement)}${td(r.clicks)}</tr>`).join('')
    : `<tr><td colspan="3" style="padding:4px 8px;">クリックなし（カスタムディメンション未登録の場合もここに表示されます）</td></tr>`;

  const newReturnHtml = newReturnRows.length > 0
    ? newReturnRows.map(r => {
        const dur = isNaN(r.avgDuration) ? '–' : fmtDuration(r.avgDuration);
        return `<tr>${tdl(r.type)}${td(r.sessions)}${td((r.engagementRate * 100).toFixed(1) + '%')}${td(dur)}</tr>`;
      }).join('')
    : `<tr><td colspan="4" style="padding:4px 8px;">データなし</td></tr>`;

  const sourceHtml = sourceRows.length > 0
    ? sourceRows.map(r =>
        `<tr>${tdl(r.sourceMedium)}${tdl(r.channel)}${td(r.sessions)}${td((r.engagementRate * 100).toFixed(1) + '%')}</tr>`).join('')
    : `<tr><td colspan="4" style="padding:4px 8px;">データなし</td></tr>`;

  const landingHtml = landingRows.length > 0
    ? landingRows.map(r =>
        `<tr>${tdl(r.path)}${td(r.sessions)}${td((r.bounceRate * 100).toFixed(1) + '%')}${td((r.engagementRate * 100).toFixed(1) + '%')}</tr>`).join('')
    : `<tr><td colspan="4" style="padding:4px 8px;">データなし</td></tr>`;

  const channelHtml = ga4Rows.length > 0
    ? ga4Rows.map(r => {
        const pvPerSession = r.sessions > 0 ? (r.pageviews / r.sessions).toFixed(2) : '–';
        const dur = isNaN(r.avgDuration) ? '–' : fmtDuration(r.avgDuration);
        return `<tr>${tdl(r.channel)}${td(r.sessions)}${td(pvPerSession)}${td(isNaN(r.bounceRate) ? '–' : (r.bounceRate * 100).toFixed(1) + '%')}${td(dur)}${td(isNaN(r.engagementRate) ? '–' : (r.engagementRate * 100).toFixed(1) + '%')}</tr>`;
      }).join('')
    : `<tr><td colspan="6" style="padding:4px 8px;">データなし</td></tr>`;

  const deviceHtml = ga4DeviceRows.length > 0
    ? ga4DeviceRows.map(r => `<tr>${tdl(r.device)}${td(r.sessions)}</tr>`).join('')
    : `<tr><td colspan="2" style="padding:4px 8px;">データなし</td></tr>`;

  const ga4PageHtml = ga4PageRows.length > 0
    ? ga4PageRows.map(r => {
        const pvPerSession = r.sessions > 0 ? (r.pageviews / r.sessions).toFixed(2) : '–';
        const dur = isNaN(r.avgDuration) ? '–' : fmtDuration(r.avgDuration);
        return `<tr>${tdl(r.path)}${td(r.sessions)}${td(r.pageviews)}${td(pvPerSession)}${td(isNaN(r.bounceRate) ? '–' : (r.bounceRate * 100).toFixed(1) + '%')}${td(dur)}${td(isNaN(r.engagementRate) ? '–' : (r.engagementRate * 100).toFixed(1) + '%')}</tr>`;
      }).join('')
    : `<tr><td colspan="7" style="padding:4px 8px;">データなし</td></tr>`;

  const pageHtml = topPages.length > 0
    ? topPages.map(r => `<tr>${tdl(shortUrl(r.keys[0]))}${td(r.clicks)}${td(r.impressions)}${td((r.ctr*100).toFixed(1)+'%')}${td(r.position.toFixed(1)+'位')}</tr>`).join('')
    : `<tr><td colspan="5" style="padding:4px 8px;">データなし</td></tr>`;

  const lowCtrHtml = lowCtr.map(r =>
    `<tr>${tdl(r.keys[0])}${td(r.impressions)}${td((r.ctr*100).toFixed(1)+'%')}${td(r.position.toFixed(1)+'位')}</tr>`
  ).join('');

  const opportunityHtml = opportunity.map(r =>
    `<tr>${tdl(r.keys[0])}${td(r.position.toFixed(1)+'位')}${td(r.impressions)}</tr>`
  ).join('');

  const subjectQueryHtml = subjectQueryRows.map(r =>
    `<tr>${tdl(r.query)}${tdl(r.subject)}${tdl(r.path)}${tdl(r.owner)}${td(r.impressions)}${td(r.clicks)}${td(r.position.toFixed(1)+'位')}</tr>`
  ).join('');

  const competingHtml = competingQueries.map(q =>
    q.pages.map((p, i) =>
      `<tr>${tdl(i === 0 ? q.query : '')}${tdl(p.path)}${td(p.impressions)}${td(p.position.toFixed(1)+'位')}</tr>`
    ).join('')
  ).join('');

  const html = `
<h2>📊 週次SEOレポート（${today}）</h2>

<h3>📈 今週 vs 先週</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('指標')}${th('今週')}${th('先週')}${th('前週比')}</tr>
  ${summaryHtml}
</table>

<h3>💰 アフィリエイトのクリック（GA4）</h3>
<p style="font-size:15px;"><strong>合計 ${affTotalMail} クリック</strong>（先週 ${prevAffTotalMail}）</p>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('案件')}${th('設置場所')}${th('クリック')}</tr>
  ${affiliateHtml}
</table>

<h3>🔁 新規とリピーター（GA4）</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('区分')}${th('セッション')}${th('エンゲージメント率')}${th('平均滞在時間')}</tr>
  ${newReturnHtml}
</table>

<h3>📱 流入元内訳（GA4）</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('チャネル')}${th('セッション')}${th('PV/セッション')}${th('直帰率')}${th('平均滞在時間')}${th('エンゲージメント率')}</tr>
  ${channelHtml}
</table>

<h3>🔍 参照元/メディアの内訳（GA4）</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('参照元 / メディア')}${th('チャネル')}${th('セッション')}${th('エンゲージメント率')}</tr>
  ${sourceHtml}
</table>

<h3>🛬 ランディングページ別（GA4）</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('着地ページ')}${th('セッション')}${th('直帰率')}${th('エンゲージメント率')}</tr>
  ${landingHtml}
</table>

<h3>💻 デバイス別内訳（GA4）</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('デバイス')}${th('セッション')}</tr>
  ${deviceHtml}
</table>

<h3>📄 ページ別閲覧数（GA4）</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('ページ')}${th('セッション')}${th('PV')}${th('PV/セッション')}${th('直帰率')}${th('平均滞在時間')}${th('エンゲージメント率')}</tr>
  ${ga4PageHtml}
</table>

<h3>📄 ページ別パフォーマンス（GSC）</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('ページ')}${th('クリック')}${th('表示')}${th('CTR')}${th('順位')}</tr>
  ${pageHtml}
</table>

${subjectQueryRows.length > 0 ? `
<h3>🔀 科目クエリをどのページが受けているか（GSC）</h3>
<p style="font-size:13px;">「⚠️ トップページ」が多い場合、科目ページがトップページに食われています。</p>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('クエリ')}${th('科目')}${th('表示中のページ')}${th('判定')}${th('表示')}${th('クリック')}${th('順位')}</tr>
  ${subjectQueryHtml}
</table>` : ''}

${competingQueries.length > 0 ? `
<h3>⚔️ 複数ページが同じクエリを取り合っているもの（GSC）</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('クエリ')}${th('ページ')}${th('表示')}${th('順位')}</tr>
  ${competingHtml}
</table>` : ''}

${lowCtr.length > 0 ? `
<h3>🔴 要対応：CTRが低いクエリ</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#fdd;">${th('クエリ')}${th('表示')}${th('CTR')}${th('順位')}</tr>
  ${lowCtrHtml}
</table>` : ''}

${opportunity.length > 0 ? `
<h3>🟡 チャンス：順位5〜20位のクエリ</h3>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#ffe;">${th('クエリ')}${th('順位')}${th('表示')}</tr>
  ${opportunityHtml}
</table>` : ''}

<h3>🎯 目標達成状況</h3>
<p style="font-size:13px;font-weight:bold;">${TARGETS.short.label}（${TARGETS.short.deadline}まで）</p>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('指標')}${th('現在')}${th('目標')}${th('達成率')}</tr>
  <tr>${tdl('週間表示回数')}${td(curr.impressions)}${td(TARGETS.short.impressions)}${td(`${goals.short.impressions.icon} ${goals.short.impressions.pct}`)}</tr>
  <tr>${tdl('週間クリック数')}${td(curr.clicks)}${td(TARGETS.short.clicks)}${td(`${goals.short.clicks.icon} ${goals.short.clicks.pct}`)}</tr>
  <tr>${tdl('平均順位')}${td(curr.position + '位')}${td(TARGETS.short.position + '位以内')}${td(`${goals.short.position.icon} ${goals.short.position.pct}`)}</tr>
  <tr>${tdl('セッション（週）')}${td(curr.sessions)}${td(TARGETS.short.sessions)}${td(`${goals.short.sessions.icon} ${goals.short.sessions.pct}`)}</tr>
</table>
<p style="font-size:13px;font-weight:bold;margin-top:12px;">${TARGETS.mid.label}（${TARGETS.mid.deadline}まで）</p>
<table border="1" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;">${th('指標')}${th('現在')}${th('目標')}${th('達成率')}</tr>
  <tr>${tdl('週間表示回数')}${td(curr.impressions)}${td(TARGETS.mid.impressions)}${td(`${goals.mid.impressions.icon} ${goals.mid.impressions.pct}`)}</tr>
  <tr>${tdl('週間クリック数')}${td(curr.clicks)}${td(TARGETS.mid.clicks)}${td(`${goals.mid.clicks.icon} ${goals.mid.clicks.pct}`)}</tr>
  <tr>${tdl('オーガニックセッション（週）')}${td(organicSessions)}${td(TARGETS.mid.organicSessions)}${td(`${goals.mid.organicSessions.icon} ${goals.mid.organicSessions.pct}`)}</tr>
</table>

<hr>
<p style="font-size:12px;color:#666;">本レポートはメールのみで配信しています（運営数値を公開リポジトリに残さないため）。</p>
`;

  await transporter.sendMail({
    from: process.env.NOTIFY_GMAIL_USER,
    to: process.env.NOTIFY_EMAIL_TO,
    subject: `📊【週次SEOレポート】${today}`,
    html,
    text: issueBody,
  });
}

async function main() {
  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  auth.setCredentials({ refresh_token: REFRESH_TOKEN });

  // 水曜に実行し、終端を3日前（日曜）とすることで月曜〜日曜の1週間を切り出す。
  // GA4は24〜48時間、GSCは2〜3日データ確定に時間がかかるため、
  // 前日までを集計対象にすると暫定値で判断してしまう（ルール25）。
  const endDate       = dateStr(3);
  const startDate     = dateStr(9);
  const prevEndDate   = dateStr(10);
  const prevStartDate = dateStr(16);
  const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const [
    gscTotals, prevGscTotals,
    gscRows, ga4Rows, prevGscRows, prevGa4Rows, gscPageRows, ga4PageRows, ga4DeviceRows,
    affiliateRows, prevAffiliateRows, newReturnRows, prevNewReturnRows, landingRows, sourceRows,
    gscQueryPageRows,
  ] = await Promise.all([
    fetchGSCTotals(auth, startDate, endDate),
    fetchGSCTotals(auth, prevStartDate, prevEndDate),
    fetchGSCByQuery(auth, startDate, endDate),
    fetchGA4(auth, startDate, endDate),
    fetchGSCByQuery(auth, prevStartDate, prevEndDate),
    fetchGA4(auth, prevStartDate, prevEndDate),
    fetchGSCByPage(auth, startDate, endDate),
    fetchGA4ByPage(auth, startDate, endDate),
    fetchGA4ByDevice(auth, startDate, endDate),
    fetchGA4Affiliate(auth, startDate, endDate),
    fetchGA4Affiliate(auth, prevStartDate, prevEndDate),
    fetchGA4NewVsReturning(auth, startDate, endDate),
    fetchGA4NewVsReturning(auth, prevStartDate, prevEndDate),
    fetchGA4Landing(auth, startDate, endDate),
    fetchGA4Source(auth, startDate, endDate),
    fetchGSCByQueryPage(auth, startDate, endDate),
  ]);

  // 今週 GSC 集計（合計値はdimensionsなしの正確な値を使用）
  const totalImpressions = gscTotals.impressions;
  const totalClicks      = gscTotals.clicks;
  const avgCtr = totalImpressions > 0
    ? (totalClicks / totalImpressions * 100).toFixed(1) : '0.0';
  const avgPosition = gscTotals.position > 0 ? gscTotals.position.toFixed(1) : '-';

  // 先週 GSC 集計
  const prevImpressions = prevGscTotals.impressions;
  const prevClicks      = prevGscTotals.clicks;
  const prevCtr = prevImpressions > 0
    ? (prevClicks / prevImpressions * 100).toFixed(1) : '0.0';
  const prevPosition = prevGscTotals.position > 0 ? prevGscTotals.position.toFixed(1) : '-';

  // 今週・先週 GA4 集計
  const totalSessions  = ga4Rows.reduce((s, r) => s + r.sessions, 0);
  const totalPageviews = ga4Rows.reduce((s, r) => s + r.pageviews, 0);
  const prevSessions   = prevGa4Rows.reduce((s, r) => s + r.sessions, 0);
  const prevPageviews  = prevGa4Rows.reduce((s, r) => s + r.pageviews, 0);

  const curr = { impressions: totalImpressions, clicks: totalClicks, ctr: avgCtr, position: avgPosition, sessions: totalSessions, pageviews: totalPageviews };
  const prev = { impressions: prevImpressions, clicks: prevClicks, ctr: prevCtr, position: prevPosition, sessions: prevSessions, pageviews: prevPageviews };

  // ページ別（クリック数順、同数なら表示回数順）
  // 上位10件で切ると、クリックがまだ0の新設ページが必ず落ちて効果測定ができない。
  // サイトのページ数（十数ページ）が収まる件数にしている。
  const topPages = [...gscPageRows]
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 20);

  // 分析：CTR低いクエリ（10回以上・CTR3%未満）
  const lowCtr = gscRows
    .filter(r => r.impressions >= 10 && r.ctr < 0.03)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5);

  // 分析：チャンスクエリ（順位5～20位）
  const opportunity = gscRows
    .filter(r => r.position >= 5 && r.position <= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);

  // 分析：好調クエリ（クリック数上位）
  const topQueries = [...gscRows]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 5);

  // 分析：科目クエリをどのページが受けているか
  // GSCのクエリは「保育の心理学 一 問 一答」のように空白が混じるため、
  // 空白を除いてから科目名を照合する。長い科目名から順に試し、
  // 「社会福祉」が「子ども家庭福祉」に誤って一致しないようにする。
  const stripSpace = s => s.replace(/[\s　]/g, '');
  const subjectNames = Object.keys(SUBJECT_PAGES)
    .sort((a, b) => b.length - a.length);

  const subjectQueryRows = gscQueryPageRows
    .map(r => {
      const [query, page] = r.keys;
      const subject = subjectNames.find(s => stripSpace(query).includes(stripSpace(s)));
      if (!subject) return null;
      const path = shortUrl(page);
      const owner = path.includes(`/${SUBJECT_PAGES[subject]}/`)
        ? '✅ 科目ページ'
        : /^\/flashcard\/?$/.test(path) ? '⚠️ トップページ' : '― 他ページ';
      return { query, subject, path, owner, impressions: r.impressions, clicks: r.clicks, position: r.position };
    })
    .filter(Boolean)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20);

  // 分析：1つのクエリを複数ページが取り合っているもの（食い合いの直接的な証拠）
  const byQuery = new Map();
  gscQueryPageRows.forEach(r => {
    const [query, page] = r.keys;
    if (!byQuery.has(query)) byQuery.set(query, []);
    byQuery.get(query).push({ path: shortUrl(page), impressions: r.impressions, position: r.position });
  });
  const competingQueries = [...byQuery.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .map(([query, pages]) => ({
      query,
      pages: pages.sort((a, b) => b.impressions - a.impressions),
      impressions: pages.reduce((s, p) => s + p.impressions, 0),
    }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);

  // 目標達成状況
  const organicSessions = ga4Rows.find(r => r.channel === '検索')?.sessions || 0;
  const posNum = parseFloat(curr.position) || 0;
  const goals = {
    short: {
      impressions: goalStatus(curr.impressions, TARGETS.short.impressions),
      clicks:      goalStatus(curr.clicks,      TARGETS.short.clicks),
      position:    goalStatus(posNum,            TARGETS.short.position, true),
      sessions:    goalStatus(curr.sessions,     TARGETS.short.sessions),
    },
    mid: {
      impressions:     goalStatus(curr.impressions, TARGETS.mid.impressions),
      clicks:          goalStatus(curr.clicks,      TARGETS.mid.clicks),
      organicSessions: goalStatus(organicSessions,  TARGETS.mid.organicSessions),
    },
  };

  // Issue 本文
  const lines = [
    `## 📊 週次SEOレポート（${today}）`,
    `集計期間：${startDate} 〜 ${endDate}`,
    '',
    '## 📈 今週 vs 先週',
    '',
    '| 指標 | 今週 | 先週 | 前週比 |',
    '|------|------|------|--------|',
    `| 表示回数（GSC） | ${curr.impressions} | ${prev.impressions} | ${diffLabel(curr.impressions, prev.impressions)} |`,
    `| クリック数（GSC） | ${curr.clicks} | ${prev.clicks} | ${diffLabel(curr.clicks, prev.clicks)} |`,
    `| 平均CTR | ${curr.ctr}% | ${prev.ctr}% | – |`,
    `| 平均順位 | ${curr.position}位 | ${prev.position}位 | – |`,
    `| セッション（GA4） | ${curr.sessions} | ${prev.sessions} | ${diffLabel(curr.sessions, prev.sessions)} |`,
    `| ページビュー（GA4） | ${curr.pageviews} | ${prev.pageviews} | ${diffLabel(curr.pageviews, prev.pageviews)} |`,
    '',
  ];

  // ---- 収益化：アフィリエイトのクリック実績 ----
  lines.push('### 💰 アフィリエイトのクリック（GA4）');
  const affTotal = affiliateRows.reduce((s, r) => s + r.clicks, 0);
  const prevAffTotal = prevAffiliateRows.reduce((s, r) => s + r.clicks, 0);
  lines.push(`**合計 ${affTotal} クリック**（先週 ${prevAffTotal}）${diffLabel(affTotal, prevAffTotal)}`, '');
  if (affiliateRows.length > 0) {
    lines.push('| 案件 | 設置場所 | クリック |');
    lines.push('|-----|---------|--------|');
    affiliateRows.forEach(r => lines.push(`| ${PROMO_LABEL[r.promo] || r.promo} | ${PLACEMENT_LABEL[r.placement] || r.placement} | ${r.clicks} |`));
  } else {
    lines.push('_クリックなし。カスタムディメンション（promo_id / placement）が未登録の場合もここに表示されます。_');
  }
  lines.push('');

  // ---- 新規とリピーターの比率 ----
  if (newReturnRows.length > 0) {
    lines.push('### 🔁 新規とリピーター（GA4）');
    lines.push('| 区分 | セッション | 先週 | エンゲージメント率 | 平均滞在時間 |');
    lines.push('|-----|-----------|------|-----------------|-------------|');
    newReturnRows.forEach(r => {
      const p = prevNewReturnRows.find(x => x.type === r.type);
      const dur = isNaN(r.avgDuration) ? '–' : fmtDuration(r.avgDuration);
      lines.push(`| ${r.type} | ${r.sessions} | ${p ? p.sessions : '–'} | ${(r.engagementRate * 100).toFixed(1)}% | ${dur} |`);
    });
    lines.push('');
  }

  lines.push('### 📱 流入元内訳（GA4）');
  lines.push('| チャネル | セッション | PV/セッション | 直帰率 | 平均滞在時間 | エンゲージメント率 |');
  lines.push('|---------|-----------|--------------|--------|-------------|-----------------|');
  if (ga4Rows.length > 0) {
    ga4Rows.forEach(r => {
      const pvPerSession = r.sessions > 0 ? (r.pageviews / r.sessions).toFixed(2) : '–';
      const dur = isNaN(r.avgDuration) ? '–' : fmtDuration(r.avgDuration);
      lines.push(`| ${r.channel} | ${r.sessions} | ${pvPerSession} | ${isNaN(r.bounceRate) ? '–' : (r.bounceRate * 100).toFixed(1) + '%'} | ${dur} | ${isNaN(r.engagementRate) ? '–' : (r.engagementRate * 100).toFixed(1) + '%'} |`);
    });
  } else {
    lines.push('| データなし | – | – | – | – | – |');
  }
  lines.push('');

  // ---- 参照元/メディアの内訳（「その他」チャネルの正体を特定するため） ----
  if (sourceRows.length > 0) {
    lines.push('### 🔍 参照元/メディアの内訳（GA4）');
    lines.push('| 参照元 / メディア | チャネル | セッション | エンゲージメント率 |');
    lines.push('|-----------------|---------|-----------|-----------------|');
    sourceRows.forEach(r => lines.push(
      `| ${r.sourceMedium} | ${r.channel} | ${r.sessions} | ${(r.engagementRate * 100).toFixed(1)}% |`));
    lines.push('');
  }

  // ---- ランディングページ別（着地点。既存のページ別は経由も含む） ----
  if (landingRows.length > 0) {
    lines.push('### 🛬 ランディングページ別（GA4）');
    lines.push('| 着地ページ | セッション | 直帰率 | エンゲージメント率 |');
    lines.push('|-----------|-----------|--------|-----------------|');
    landingRows.forEach(r => lines.push(
      `| ${r.path} | ${r.sessions} | ${(r.bounceRate * 100).toFixed(1)}% | ${(r.engagementRate * 100).toFixed(1)}% |`));
    lines.push('');
  }

  if (ga4DeviceRows.length > 0) {
    lines.push('### 📱 デバイス別内訳（GA4）');
    lines.push('| デバイス | セッション |');
    lines.push('|---------|-----------|');
    ga4DeviceRows.forEach(r => lines.push(`| ${r.device} | ${r.sessions} |`));
    lines.push('');
  }

  if (ga4PageRows.length > 0) {
    lines.push('### 📄 ページ別閲覧数（GA4）');
    lines.push('| ページ | セッション | PV | PV/セッション | 直帰率 | 平均滞在時間 | エンゲージメント率 |');
    lines.push('|-------|-----------|-----|--------------|--------|-------------|-----------------|');
    ga4PageRows.forEach(r => {
      const pvPerSession = r.sessions > 0 ? (r.pageviews / r.sessions).toFixed(2) : '–';
      const dur = isNaN(r.avgDuration) ? '–' : fmtDuration(r.avgDuration);
      lines.push(`| ${r.path} | ${r.sessions} | ${r.pageviews} | ${pvPerSession} | ${isNaN(r.bounceRate) ? '–' : (r.bounceRate * 100).toFixed(1) + '%'} | ${dur} | ${isNaN(r.engagementRate) ? '–' : (r.engagementRate * 100).toFixed(1) + '%'} |`);
    });
    lines.push('');
  }

  if (topPages.length > 0) {
    lines.push('---', '');
    lines.push('## 📄 ページ別パフォーマンス（GSC）', '');
    lines.push('| ページ | クリック | 表示回数 | CTR | 順位 |');
    lines.push('|-------|--------|---------|-----|-----|');
    topPages.forEach(r => lines.push(
      `| ${shortUrl(r.keys[0])} | ${r.clicks} | ${r.impressions} | ${(r.ctr*100).toFixed(1)}% | ${r.position.toFixed(1)}位 |`
    ));
    lines.push('');
  }

  if (subjectQueryRows.length > 0) {
    lines.push('---', '');
    lines.push('## 🔀 科目クエリをどのページが受けているか（GSC）');
    lines.push('「⚠️ トップページ」が多い場合、科目ページがトップページに食われています。'
             + '内部リンクや title の差別化で科目ページに寄せる余地があります。', '');
    lines.push('| クエリ | 科目 | 表示中のページ | 判定 | 表示回数 | クリック | 順位 |');
    lines.push('|-------|-----|--------------|-----|---------|--------|-----|');
    subjectQueryRows.forEach(r => lines.push(
      `| ${r.query} | ${r.subject} | ${r.path} | ${r.owner} | ${r.impressions} | ${r.clicks} | ${r.position.toFixed(1)}位 |`
    ));
    lines.push('');
  }

  if (competingQueries.length > 0) {
    lines.push('---', '');
    lines.push('## ⚔️ 複数ページが同じクエリを取り合っているもの（GSC）');
    lines.push('同一クエリに複数ページが表示されている状態です。'
             + '評価が分散するため、どちらを主役にするか決めて整理する候補になります。', '');
    lines.push('| クエリ | ページ | 表示回数 | 順位 |');
    lines.push('|-------|-------|---------|-----|');
    competingQueries.forEach(q => {
      q.pages.forEach((p, i) => lines.push(
        `| ${i === 0 ? q.query : ''} | ${p.path} | ${p.impressions} | ${p.position.toFixed(1)}位 |`
      ));
    });
    lines.push('');
  }

  if (lowCtr.length > 0) {
    lines.push('---', '');
    lines.push('## 🔴 要対応：表示されているがクリックされていないクエリ');
    lines.push('title・descriptionを改善してCTRを上げましょう。', '');
    lines.push('| クエリ | 表示回数 | クリック | CTR | 順位 |');
    lines.push('|-------|---------|--------|-----|-----|');
    lowCtr.forEach(r => lines.push(
      `| ${r.keys[0]} | ${r.impressions} | ${r.clicks} | ${(r.ctr*100).toFixed(1)}% | ${r.position.toFixed(1)}位 |`
    ));
    lines.push('');
  }

  if (opportunity.length > 0) {
    lines.push('---', '');
    lines.push('## 🟡 チャンス：順位5～20位のクエリ');
    lines.push('Xでの発信強化や問題の充実で上位表示が狙えます。', '');
    lines.push('| クエリ | 順位 | 表示回数 | クリック |');
    lines.push('|-------|-----|---------|--------|');
    opportunity.forEach(r => lines.push(
      `| ${r.keys[0]} | ${r.position.toFixed(1)}位 | ${r.impressions} | ${r.clicks} |`
    ));
    lines.push('');
  }

  if (topQueries.length > 0) {
    lines.push('---', '');
    lines.push('## 🟢 好調：クリック数トップクエリ', '');
    lines.push('| クエリ | クリック | 表示回数 | CTR | 順位 |');
    lines.push('|-------|--------|---------|-----|-----|');
    topQueries.forEach(r => lines.push(
      `| ${r.keys[0]} | ${r.clicks} | ${r.impressions} | ${(r.ctr*100).toFixed(1)}% | ${r.position.toFixed(1)}位 |`
    ));
    lines.push('');
  }

  lines.push('---', '');
  lines.push('## 🎯 目標達成状況', '');
  lines.push(`### ${TARGETS.short.label}（${TARGETS.short.deadline}まで）`, '');
  lines.push('| 指標 | 現在 | 目標 | 達成率 |');
  lines.push('|------|------|------|--------|');
  lines.push(`| 週間表示回数 | ${curr.impressions} | ${TARGETS.short.impressions} | ${goals.short.impressions.icon} ${goals.short.impressions.pct} |`);
  lines.push(`| 週間クリック数 | ${curr.clicks} | ${TARGETS.short.clicks} | ${goals.short.clicks.icon} ${goals.short.clicks.pct} |`);
  lines.push(`| 平均順位 | ${curr.position}位 | ${TARGETS.short.position}位以内 | ${goals.short.position.icon} ${goals.short.position.pct} |`);
  lines.push(`| セッション（週） | ${curr.sessions} | ${TARGETS.short.sessions} | ${goals.short.sessions.icon} ${goals.short.sessions.pct} |`);
  lines.push('');
  lines.push(`### ${TARGETS.mid.label}（${TARGETS.mid.deadline}まで）`, '');
  lines.push('| 指標 | 現在 | 目標 | 達成率 |');
  lines.push('|------|------|------|--------|');
  lines.push(`| 週間表示回数 | ${curr.impressions} | ${TARGETS.mid.impressions} | ${goals.mid.impressions.icon} ${goals.mid.impressions.pct} |`);
  lines.push(`| 週間クリック数 | ${curr.clicks} | ${TARGETS.mid.clicks} | ${goals.mid.clicks.icon} ${goals.mid.clicks.pct} |`);
  lines.push(`| オーガニックセッション（週） | ${organicSessions} | ${TARGETS.mid.organicSessions} | ${goals.mid.organicSessions.icon} ${goals.mid.organicSessions.pct} |`);
  lines.push('');

  lines.push('---', '');
  lines.push('## ✅ 今週の対応チェックリスト');
  lines.push('- [ ] 🔴 CTRが低いクエリのtitle/descriptionを見直す');
  lines.push('- [ ] 🟡 チャンスクエリをXで重点的に発信する');
  lines.push('- [ ] 流入元を確認し、弱いチャネルへの施策を検討する');
  lines.push('- [ ] 📄 ページ別パフォーマンスで科目ページの効果を確認する');

  const issueBody = lines.join('\n');
  if (CREATE_ISSUE) {
    await createIssue(`[SEOレポート] ${today}`, issueBody);
    console.log('✅ SEOレポートIssue作成完了');
  } else {
    console.log('ℹ️ Issueの作成をスキップしました（運営数値を公開しないため）。メールのみ送信します。');
  }

  await sendEmail({ today, curr, prev, ga4Rows, ga4PageRows, ga4DeviceRows, topPages, lowCtr, opportunity, goals, organicSessions,
                    affiliateRows, prevAffiliateRows, newReturnRows, landingRows, sourceRows,
                    subjectQueryRows, competingQueries }, issueBody);
  console.log('✅ SEOレポートメール送信完了');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
