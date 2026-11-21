// Apple Silicon Macs refuse to open an app with a broken or missing signature
// ("Image Bender is damaged"). Without a paid Developer ID we sign ad hoc,
// which is free and makes the app open after right-click -> Open.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('  • ad-hoc signed ' + app);
};
