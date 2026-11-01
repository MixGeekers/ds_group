import sys, re, html
src, dst = sys.argv[1], sys.argv[2]
t = open(src, encoding='utf-8', errors='ignore').read()
t = re.sub(r'<script.*?</script>', ' ', t, flags=re.S|re.I)
t = re.sub(r'<style.*?</style>', ' ', t, flags=re.S|re.I)
t = re.sub(r'<[^>]+>', '\n', t)
t = html.unescape(t)
t = re.sub(r'\n\s*\n+', '\n', t)
t = re.sub(r'[ \t]+', ' ', t)
open(dst, 'w').write(t)
