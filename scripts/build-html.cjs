const fs = require("fs");
const css = fs.readFileSync("public/_style.css", "utf8");
const js = fs.readFileSync("public/_app.js", "utf8");

const icons = {
  omni: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="M3 12h2"/><path d="M19 12h2"/></svg>'
};

const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>OmniCodex Gateway</title>\n<style>\n' + css + '\n</style>\n</head>\n<body>\n' +
'<aside class="sidebar"><div class="logo">' + icons.omni + ' OmniCodex</div>\n' +
'<button class="nav-item active" data-page="dashboard"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> Dashboard</button>\n' +
'<button class="nav-item" data-page="providers"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> Providers</button>\n' +
'<button class="nav-item" data-page="models"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="8" y1="8" x2="8" y2="8.01"/><line x1="8" y1="12" x2="8" y2="12.01"/><line x1="8" y1="16" x2="8" y2="16.01"/></svg> Models</button>\n' +
'<button class="nav-item" data-page="playground"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Playground</button>\n' +
'<button class="nav-item" data-page="profile"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Profile</button>\n' +
'<button class="nav-item" data-page="logs"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Logs</button>\n' +
'</aside>\n<main class="main" id="main"></main>\n<div id="toast" class="toast hidden"></div>\n' +
'<script>\n' + js + '\n</' + 'script>\n</body>\n</html>\n';

fs.writeFileSync("public/index.html", html, "utf8");
console.log("index.html built:", html.length, "chars");
