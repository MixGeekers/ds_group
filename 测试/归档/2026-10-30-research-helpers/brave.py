import sys, re, html, urllib.request, urllib.parse
q = sys.argv[1]
url = "https://search.brave.com/search?q=" + urllib.parse.quote(q)
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "Accept-Language": "en-US,en;q=0.9"})
t = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
seen = set()
out = []
for m in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', t, re.S):
    u, txt = m.group(1), html.unescape(re.sub(r'<[^>]+>', '', m.group(2))).strip()
    if 'brave.com' in u: continue
    if not txt or len(txt) < 8: continue
    if u in seen: continue
    seen.add(u)
    out.append((txt[:90], u))
for txt, u in out[:10]:
    print(txt, '||', u)
if not out: print("NO RESULTS")
