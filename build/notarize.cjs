/* Electron-builder afterSign hook.
   Only notarizes when Apple credentials are present, so unsigned local builds still work.

   支持三种凭据（按优先级）：
   1. APPLE_KEYCHAIN_PROFILE：用 `xcrun notarytool store-credentials` 存进 Keychain 的 profile（推荐本地）
   2. APPLE_API_KEY + APPLE_API_KEY_ID (+ APPLE_API_ISSUER)：App Store Connect API Key
   3. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID：Apple ID + App 专用密码
*/
const path = require('node:path');

function credentials() {
  const profile = String(process.env.APPLE_KEYCHAIN_PROFILE || '').trim();
  if (profile) return { keychainProfile: profile };

  const apiKey = String(process.env.APPLE_API_KEY || '').trim();
  const apiKeyId = String(process.env.APPLE_API_KEY_ID || '').trim();
  if (apiKey && apiKeyId) {
    const issuer = String(process.env.APPLE_API_ISSUER || '').trim();
    return {
      appleApiKey: apiKey,
      appleApiKeyId: apiKeyId,
      ...(issuer ? { appleApiIssuer: issuer } : {}),
    };
  }

  const appleId = String(process.env.APPLE_ID || '').trim();
  const password = String(process.env.APPLE_APP_SPECIFIC_PASSWORD || '').trim();
  const teamId = String(process.env.APPLE_TEAM_ID || '').trim();
  if (appleId && password && teamId) {
    return { appleId, appleIdPassword: password, teamId };
  }
  return null;
}

exports.default = async function notarizing(context) {
  if (process.platform !== 'darwin') return;
  const creds = credentials();
  if (!creds) {
    console.log(
      '  • notarize skipped (set APPLE_KEYCHAIN_PROFILE, or APPLE_API_KEY + APPLE_API_KEY_ID, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)'
    );
    return;
  }
  const { notarize } = require('@electron/notarize');
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`  • notarizing ${appPath}`);
  await notarize({ appPath, ...creds });
  console.log('  • notarized');
};
