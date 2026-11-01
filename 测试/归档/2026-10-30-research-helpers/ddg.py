import sys, re, html, urllib.request, urllib.parse, time
q = sys.argv[1]
url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q)
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
t = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
links = re.findall(r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', t)
for u, title in links[:10]:
    m = re.search(r'uddg=([^&]+)', u)
    if m: u = urllib.parse.unquote(m.group(1))
    title = html.unescape(re.sub(r'<[^>]+>', '', title))
    print(title, '||', u)
