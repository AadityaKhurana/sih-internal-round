#!/usr/bin/env python3
"""
Build a single self-contained HTML page for auditing detector output.

    python audit_crops.py out/ audit.html
    open audit.html

Click a verdict for each crop, then hit "Copy CSV" and paste into a file.
No server, no install, images embedded -- works offline at the venue.

Verdicts:
    PLATE     -- a real plate, characters legible to you
    PARTIAL   -- a real plate but you cannot read all characters
    NOT_PLATE -- a sticker, bus board, panel, anything else

Precision = PLATE / (PLATE + PARTIAL + NOT_PLATE)
Strict precision = PLATE / total
"""
import base64
import os
import sys

IMG_EXT = {".jpg", ".jpeg", ".png"}

PAGE = """<!doctype html><meta charset=utf-8>
<title>Crop audit</title>
<style>
 body{{font:14px system-ui,sans-serif;margin:24px;background:#111;color:#eee}}
 h1{{font-size:18px}}
 #bar{{position:sticky;top:0;background:#111;padding:12px 0;border-bottom:1px solid #333;z-index:9}}
 button{{font:14px system-ui;padding:8px 14px;margin-right:8px;cursor:pointer;
        background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:6px}}
 .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:20px;margin-top:18px}}
 .card{{border:1px solid #333;border-radius:8px;padding:12px;background:#1a1a1a}}
 /* crops are 90-150px wide; upscale hard and keep edges crisp so you judge
    the pixels you actually have, not a smoothed guess */
 .card img{{width:100%;image-rendering:pixelated;background:#000;border-radius:4px;
            cursor:zoom-in;min-height:120px;object-fit:contain}}
 .fn{{font:11px ui-monospace,monospace;color:#888;word-break:break-all;margin:6px 0}}
 .opts label{{display:inline-block;margin-right:10px;font-size:12px;cursor:pointer}}
 .card.done{{border-color:#3a6}}
 #res{{display:none;position:fixed;inset:0;background:#000e;z-index:100;
        align-items:center;justify-content:center}}
 #res.on{{display:flex}}
 #resbox{{background:#181818;border:1px solid #444;border-radius:10px;padding:18px;
          width:min(760px,92vw)}}
 #out{{width:100%;height:280px;font:12px ui-monospace,monospace;
       background:#000;color:#6f6;border:1px solid #333;border-radius:6px;padding:8px}}
 #stat{{display:inline-block;margin-left:12px;color:#9a9}}
 /* click any crop for a full-screen look before judging it */
 #lb{{display:none;position:fixed;inset:0;background:#000d;z-index:99;
      align-items:center;justify-content:center;cursor:zoom-out}}
 #lb.on{{display:flex}}
 #lb img{{max-width:96vw;max-height:88vh;image-rendering:pixelated}}
 #lbn{{position:fixed;bottom:14px;left:0;right:0;text-align:center;
       font:12px ui-monospace,monospace;color:#bbb}}
 kbd{{background:#333;border:1px solid #555;border-radius:4px;padding:1px 5px;font-size:11px}}
</style>
<h1>Crop audit &mdash; {n} crops from {folder}</h1>
<div id=bar>
  <button onclick="mk()">Show CSV</button>
  <button onclick="dl()">Download CSV</button>
  <span id=stat>0 / {n} judged</span>
  <span id=live style="margin-left:14px;font:13px ui-monospace,monospace;color:#7d7"></span>
  <span style="margin-left:16px;color:#777;font-size:12px">
    click a crop to enlarge &middot; then <kbd>1</kbd> plate <kbd>2</kbd> partial <kbd>3</kbd> not a plate
  </span>
</div>
<div id=lb onclick="this.classList.remove('on')"><img id=lbi><div id=lbn></div></div>
<div class=grid>{cards}</div>
<div id=res>
 <div id=resbox>
   <b>Results</b>
   <textarea id=out></textarea>
   <button onclick="cp()">Copy to clipboard</button>
   <button onclick="document.getElementById('res').classList.remove('on')">Close</button>
 </div>
</div>
<script>
const N={n};
function upd(){{
  document.querySelectorAll('.card').forEach(c=>{{
    c.classList.toggle('done', !!c.querySelector('input:checked'));
  }});
  const d=document.querySelectorAll('.card.done').length;
  document.getElementById('stat').textContent = d+' / '+N+' judged';
  // running tally, always visible -- this is the number you actually need
  const t={{}};
  document.querySelectorAll('.card').forEach(c=>{{
    const s=c.querySelector('input:checked');
    if(s) t[s.value]=(t[s.value]||0)+1;
  }});
  const p=t.PLATE||0, pa=t.PARTIAL||0, np=t.NOT_PLATE||0;
  document.getElementById('live').textContent =
    'PLATE='+p+'  PARTIAL='+pa+'  NOT_PLATE='+np+
    '   |  strict '+(100*p/N).toFixed(1)+'%   usable '+(100*(p+pa)/N).toFixed(1)+'%';
}}
function mk(){{
  let rows=['filename,verdict'], tally={{}};
  document.querySelectorAll('.card').forEach(c=>{{
    const s=c.querySelector('input:checked');
    const v=s?s.value:'UNJUDGED';
    tally[v]=(tally[v]||0)+1;
    rows.push(c.dataset.fn+','+v);
  }});
  let sum='# '+Object.entries(tally).map(([k,v])=>k+'='+v).join('  ');
  const p=(tally.PLATE||0), tot=N;
  sum+='\\n# strict precision = '+(100*p/tot).toFixed(1)+'%  ('+p+'/'+tot+')';
  document.getElementById('out').value=sum+'\\n'+rows.join('\\n');
}}
function dl(){{
  mk();
  const b=new Blob([document.getElementById('out').value],{{type:'text/csv'}});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(b); a.download='audit.csv'; a.click();
}}
function cp(){{
  const t=document.getElementById('out'); t.select();
  navigator.clipboard.writeText(t.value).catch(()=>document.execCommand('copy'));
}}
document.addEventListener('change',upd);
upd();

// ---- lightbox + keyboard judging -------------------------------------
let cur=-1;
const cards=[...document.querySelectorAll('.card')];
function show(i){{
  if(i<0||i>=cards.length) return;
  cur=i;
  const c=cards[i];
  document.getElementById('lbi').src=c.querySelector('img').src;
  document.getElementById('lbn').textContent=
    (i+1)+' / '+cards.length+'   '+c.dataset.fn;
  document.getElementById('lb').classList.add('on');
}}
cards.forEach((c,i)=>c.querySelector('img').onclick=e=>{{e.stopPropagation();show(i);}});
document.addEventListener('keydown',e=>{{
  const open=document.getElementById('lb').classList.contains('on');
  if(e.key==='Escape'){{document.getElementById('lb').classList.remove('on');return;}}
  if(!open) return;
  const map={{'1':'PLATE','2':'PARTIAL','3':'NOT_PLATE'}};
  if(map[e.key]){{
    const r=cards[cur].querySelector(`input[value=${{map[e.key]}}]`);
    r.checked=true; upd();
    if(cur+1<cards.length) show(cur+1);
    else document.getElementById('lb').classList.remove('on');
  }}
  if(e.key==='ArrowRight') show(cur+1);
  if(e.key==='ArrowLeft')  show(cur-1);
}});
</script>
"""

CARD = """<div class=card data-fn="{fn}">
 <img src="data:image/jpeg;base64,{b64}">
 <div class=fn>{fn}</div>
 <div class=opts>
  <label><input type=radio name="r{i}" value=PLATE> plate</label>
  <label><input type=radio name="r{i}" value=PARTIAL> partial</label>
  <label><input type=radio name="r{i}" value=NOT_PLATE> not a plate</label>
 </div>
</div>"""


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    folder, out_html = sys.argv[1], sys.argv[2]

    files = sorted(f for f in os.listdir(folder)
                   if os.path.splitext(f)[1].lower() in IMG_EXT)
    if not files:
        sys.exit(f"no images in {folder}")

    cards = []
    for i, f in enumerate(files):
        with open(os.path.join(folder, f), "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        cards.append(CARD.format(fn=f, b64=b64, i=i))

    with open(out_html, "w", encoding="utf-8") as fh:
        fh.write(PAGE.format(n=len(files), folder=folder,
                             cards="\n".join(cards)))

    size_mb = os.path.getsize(out_html) / 1e6
    print(f"wrote {out_html}  ({len(files)} crops, {size_mb:.1f} MB)")
    print("open it in a browser, judge each crop, then Copy CSV")


if __name__ == "__main__":
    main()
