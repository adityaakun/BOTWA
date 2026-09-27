module.exports = {
  TokenBot: 'TokenKamu',
  ApiID: 33727135,  //Ganti Punya Lu
  ApiHash: '6f18d3a078e15081fccae112c67ec5a3', //Ganti Punya Lu
  ApiTg: 'https://api.telegram.org',
  MaxSize: 2000,
  DirFile: './tmp',

  GITHUB_TOKEN: 'GitHubToken',
  GITHUB_OWNER: 'UserGithub',
  GITHUB_REPO: 'RepoGithub',
  GITHUB_BRANCH: 'main',//Jan di ganti
  GITHUB_WORKFLOW_FILE: 'build.yml', // Samakan dengan di gh lu

  POLL_INTERVAL_MS: 15000,
  POLL_TIMEOUT_MS: 35 * 60000,
  ESTIMATED_BUILD_MS: 8 * 60000,
  
  START_IMAGE: 'https://files.catbox.moe/m9cm8w.jpg',
  START_TEXT: `<blockquote>
ⓘ NTED WEB2APK GEN BETA
━━━━━━━━━━━━━━━━━━
⎙ New update gen beta
 ᯤ Fast build project
 ᯤ Anti backup file kamu
 ᯤ Build simple no ribet
 ᯤ Tanpa perlu akses atau credit
 
━━━━━━━━━━━━━━━━━━
⎙ Tutorial build project to app
 ᯤ Kirim project berupa <b>ZIP</b>
 ᯤ Pastikan ada <b>pubspec.yaml</b>
 ᯤ Pilih mode release atau debug
 ᯤ Sudah proses, silahkan tunggu

 ━━━━━━━━━━━━━━━━━━
☕ Kirimkan zip anda sekarang!
 </blockquote>
`,

  OWNER_CHAT_ID: 8522032505,  //Ganti Punya Lu
  ADMIN_IDS: [],
  SUPEROWNER_IDS: [8522032505], //Ganti Punya Lu
  NOTIF_CHANNEL_ID: -1003752062491, //Ganti Punya Lu
  NOTIF_CHANNEL_USERNAME: '@NtedCrasherExec', //Ganti Punya Lu
  REQUIRE_JOIN_CHANNEL: true,
  
  DATA_DIR: './backups',
  BACKUP_DIR: './backups',

  MAINTENANCE_MODE: false, 
  
  MAINTENANCE_TEXT:
    '🛠️ <b>Bot sedang maintenance.</b>\n\n' +
    'Mohon maaf, saat ini bot tidak bisa dipakai untuk sementara waktu.\n' +
    'Silakan coba lagi nanti ya 🙏',
};
