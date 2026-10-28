import { useLocale } from '@/lib/use-locale';

// Kept here instead of the shared locale files so these fork-only screens
// don't touch files upstream edits every release.
const ZH = {
  connectTitle: '選一個 AI 幫你做簡報',
  connectDescription: '用你自己的帳號登入。第一次使用要先下載，之後打開就能直接用。',
  codexName: 'ChatGPT',
  codexNote: '免費方案就能用，額度比較少。',
  codexKeyName: 'OpenAI',
  codexKeyNote: '貼上你的 OpenAI API key，費用由 OpenAI 依用量向你收取。',
  claudeName: 'Claude',
  claudeNote:
    '貼上你的 Anthropic API key，費用由 Anthropic 依用量向你收取；Pro 或 Max 方案不能用在這裡。',
  download: '下載（約 {size}）',
  downloading: '下載中 {percent}%',
  downloadPreparing: '準備下載…',
  login: '登入',
  loginStarting: '正在打開登入頁…',
  loginWaiting: '瀏覽器已打開登入頁，登入完成後這裡會自動接上。',
  loginFallback: '瀏覽器沒有打開？點這裡',
  loginCodeLabel: '如果頁面給你一串代碼，貼在這裡：',
  loginCodeSubmit: '送出',
  loginCancel: '取消',
  claudeKeyLabel: 'Anthropic API key',
  codexKeyLabel: 'OpenAI API key',
  keySubmit: '登入',
  claudeKeyCreate: '到 Anthropic Console 建立 API key',
  codexKeyCreate: '到 OpenAI 建立 API key',
  use: '使用這個',
  inUse: '使用中',
  logout: '登出',
  logoutOf: '登出 {name}',
  loggedOutHint: '還沒登入，或登入已經過期。',
  failed: '沒有成功：',
  errorAuthTitle: '請先登入',
  errorAuthBody: 'AI 還沒登入或登入已過期。請按「登入」重新登入，完成後再送一次。',
  errorQuotaTitle: '免費額度用完了',
  errorQuotaBody:
    '這個 AI 帳號的使用額度暫時用完了，通常過幾個小時會恢復。可以等一下再試，或換另一個 AI。',
  errorNetworkTitle: '網路連線中斷',
  errorNetworkBody: '請確認網路正常，再送一次訊息。',
  errorOtherTitle: '出了點問題',
  details: '技術細節',
  notice: '提醒：',
};

const EN: typeof ZH = {
  connectTitle: 'Pick an AI to build your slides',
  connectDescription:
    'Sign in with your own account. The first time it downloads once; after that it opens straight away.',
  codexName: 'ChatGPT',
  codexNote: 'Works on the free plan, with a smaller allowance.',
  codexKeyName: 'OpenAI',
  codexKeyNote: 'Paste your OpenAI API key; OpenAI bills you for what you use.',
  claudeName: 'Claude',
  claudeNote:
    'Sign in with an Anthropic Console account, billed by usage; Pro and Max plans do not apply.',
  download: 'Download (about {size})',
  downloading: 'Downloading {percent}%',
  downloadPreparing: 'Preparing download…',
  login: 'Sign in',
  loginStarting: 'Opening the sign-in page…',
  loginWaiting:
    'The sign-in page is open in your browser; this connects by itself once you finish.',
  loginFallback: "Browser didn't open? Click here",
  loginCodeLabel: 'If the page gives you a code, paste it here:',
  loginCodeSubmit: 'Send',
  loginCancel: 'Cancel',
  claudeKeyLabel: 'Anthropic API key',
  codexKeyLabel: 'OpenAI API key',
  keySubmit: 'Sign in',
  claudeKeyCreate: 'Create an API key in the Anthropic Console',
  codexKeyCreate: 'Create an API key at OpenAI',
  use: 'Use this',
  inUse: 'In use',
  logout: 'Sign out',
  logoutOf: 'Sign out of {name}',
  loggedOutHint: 'Not signed in, or the sign-in expired.',
  failed: 'That did not work: ',
  errorAuthTitle: 'Sign in first',
  errorAuthBody:
    'The AI is not signed in or the sign-in expired. Press Sign in, then send the message again.',
  errorQuotaTitle: 'The allowance is used up',
  errorQuotaBody:
    "This AI account's allowance is used up for now and usually comes back within a few hours. Try again later or switch to the other AI.",
  errorNetworkTitle: 'The connection dropped',
  errorNetworkBody: 'Check the network, then send the message again.',
  errorOtherTitle: 'Something went wrong',
  details: 'Technical details',
  notice: 'Note: ',
};

export function useAgentForkStrings() {
  return useLocale().id.startsWith('zh') ? ZH : EN;
}
