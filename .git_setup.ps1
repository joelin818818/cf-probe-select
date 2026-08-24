cd d:/Personal/szjm/Documents/cursor/CF_SITE_IP
git init
git remote add origin https://github.com/joelin818818/cf-probe-select.git
git add -A
git commit -q -m "init: cf-probe-select base crawler and project scaffold"
git branch -M main
git push -u origin main 2>&1 | Out-String | Write-Output
