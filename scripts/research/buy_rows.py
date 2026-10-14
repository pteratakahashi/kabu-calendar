#!/usr/bin/env python3
# 買いシグナルの条件探し用データ: build_bias.py の過去の結果を長い期間（PAST_DAYS=760）で作り、特徴量つきで pickle に保存
import json, sys, pickle, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build_bias as b
b.PAST_DAYS = 760
out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
orig = b.DATA
# 書き出し先を一時的に差し替え（本番の bias.json を汚さない）
import shutil, tempfile
tmp = Path(tempfile.mkdtemp(dir=out_dir))
real_write = Path.write_text
def wt(self, *a, **k):
    if self.name in ("bias.json", "bias_past.json"):
        self = tmp / self.name
    return real_write(self, *a, **k)
Path.write_text = wt
b.main()
Path.write_text = real_write
past = json.loads((tmp / "bias_past.json").read_text())["items"]
rows = []
for x in past:
    a = x["a"]
    if a["r"] is None: continue
    r = [v for v in x["r"] if v is not None]
    rows.append(dict(d=x["d"], c=x["c"], k=x["k"], ser=(x.get("id") or "earn")[11:] if x["k"] == "ev" else "earn",
                     n=x["n"], w=x["w"], rate=x["w"] / x["n"], avg=x["avg"], t=x["t"],
                     last5=sum(v > 0 for v in r[:5]), last3=sum(v > 0 for v in r[:3]),
                     med=sorted(r)[len(r) // 2], minr=min(r),
                     xr=sum((v - (nk or 0)) > 0 for v, nk in zip(x["r"], x["nk"]) if v is not None) / max(1, len(r)),
                     g=a["g"], R=a["r"], I=(None if a["g"] is None else ((1 + a["r"] / 100) / (1 + a["g"] / 100) - 1) * 100),
                     W=a["w1"], nkR=a["nk"]))
pickle.dump(rows, open(out_dir / "buy_rows.pkl", "wb"))
print(len(rows), min(r["d"] for r in rows), max(r["d"] for r in rows))
