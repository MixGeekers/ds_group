import sys, re, html, base64, urllib.request, urllib.parse

def realurl(u):
    if 'bing.com/ck/' in u:
        m = re.search(r'[?&]u=a1([^&]+)', u)
        if m:
            s = m.group(1)
            s += '=' * (-len(s) % 4)
            try: return base64.urlsafe_b64decode(s).decode('utf-8', 'ignore')
            except Exception: return u
    return u

q = sys.argv[1]
url = "https://www.bing.com/search?q=" + urllib.parse.quote(q) + "&count=15"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "Accept-Language": "en-US,en;q=0.9"})
t = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
items = re.findall(r'<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)</a></h2>', t, re.S)
for u, title in items[:10]:
    print(html.unescape(re.sub(r'<[^>]+>', '', title)).strip(), '||', realurl(u))
if not items: print("NO RESULTS")
