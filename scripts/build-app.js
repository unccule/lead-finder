// Сборка Lead Finder в отдельную программу для Windows.
//
//   npm run build:app                 → dist\Lead Finder-win32-x64\Lead Finder.exe + ярлыки
//   npm run build:app -- --no-shortcuts  → то же, но без ярлыков
//
// Что происходит:
//  1. Записываем electron/build-info.json — путь к папке data этого проекта, чтобы программа
//     работала с той же базой, что и версия в браузере.
//  2. @electron/packager собирает папку с программой: Electron + наши файлы (упакованы в app.asar).
//     Тесты, база, git и инструменты разработки внутрь не попадают.
//  3. Создаём ярлыки «Lead Finder» на рабочем столе и в меню «Пуск».
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_NAME = 'Lead Finder';
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

writeFileSync(path.join(ROOT, 'electron', 'build-info.json'), JSON.stringify({
  projectDataDir: path.join(ROOT, 'data'),
  builtAt: new Date().toISOString(),
}, null, 2));

console.log('Собираю программу… (первый раз может занять минуту)');
const [appDir] = await packager({
  dir: ROOT,
  name: APP_NAME,
  platform: 'win32',
  arch: 'x64',
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  asar: true, // наши файлы — одним архивом app.asar внутри программы
  prune: true, // инструменты разработки (electron, packager) внутрь не кладём
  icon: path.join(ROOT, 'build', 'icon.ico'),
  appVersion: pkg.version,
  appCopyright: 'Lead Finder',
  win32metadata: {
    CompanyName: APP_NAME,
    FileDescription: 'Lead Finder — поиск клиентов на создание сайтов',
    ProductName: APP_NAME,
    InternalName: APP_NAME,
    OriginalFilename: `${APP_NAME}.exe`,
  },
  // Пути относительно папки проекта: что НЕ класть в программу.
  ignore: [
    /^\/(test|data|dist|scripts|node_modules|\.git|\.claude|\.vscode)(\/|$)/, // node_modules: у программы нет зависимостей
    /^\/(\.env|\.env\.example|\.gitignore|\.gitattributes|start-leads\.cmd|README\.md|package-lock\.json)$/,
  ],
});

const exe = path.join(appDir, `${APP_NAME}.exe`);
console.log(`Готово: ${exe}`);

if (!process.argv.includes('--no-shortcuts')) {
  // Ярлыки создаём через стандартный объект Windows «WScript.Shell» (то же, что «Создать ярлык» в проводнике).
  const script = `
    $shell = New-Object -ComObject WScript.Shell
    $places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
    foreach ($dir in $places) {
      $link = $shell.CreateShortcut((Join-Path $dir 'Lead Finder.lnk'))
      $link.TargetPath = $env:LF_EXE
      $link.WorkingDirectory = Split-Path $env:LF_EXE
      $link.IconLocation = "$env:LF_EXE,0"
      $link.Description = $env:LF_DESCRIPTION
      $link.Save()
      Write-Output (Join-Path $dir 'Lead Finder.lnk')
    }`;
  const created = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, LF_EXE: exe, LF_DESCRIPTION: 'Lead Finder — поиск клиентов на создание сайтов' },
    encoding: 'utf8',
  });
  console.log('Ярлыки:');
  for (const line of created.trim().split(/\r?\n/)) console.log(`  ${line}`);
}
