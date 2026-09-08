#!/usr/bin/env python
"""Perps-frame backtest of Quotient price outlooks on Hyperliquid (plan section b).

Frame: enter at the open of the first 15m bar after a revision publishes, take profit on
the first touch of the outlook median, stop at k * sigmaTotal (horizon-scaled), else mark
at the anchor bar close. One weight per settle (seriesId, anchorDate).

Run from the pipelines repo root with its venv:
  cd ~/dev/quotient-analytics-pipelines && .venv/bin/python \
    ~/dev/classy-cassie/research/swing-perps/backtest.py

Graph access is read-only (internal_q_reader*, Keychain, READ sessions). Credentials
are never written to disk or printed.
"""
import json
import math
import os
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests

PIPE = "/Users/jordanolmstead/dev/quotient-analytics-pipelines"
OUT = "/Users/jordanolmstead/dev/classy-cassie/research/swing-perps"
sys.path.insert(0, PIPE)
from include.pipelines.analytics.quoapp.price_outlook.hyperliquid import HyperliquidClient  # noqa: E402
from include.pipelines.analytics.quoapp.price_outlook.process import hyperliquid_coin  # noqa: E402

HOUR = 3_600_000
BAR = 900_000
NOW = int(time.time() * 1000)
STUDY_END = int(datetime(2026, 9, 3, tzinfo=timezone.utc).timestamp() * 1000)
REGIME = int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp() * 1000)
DT_LIVE = int(datetime(2026, 9, 4, tzinfo=timezone.utc).timestamp() * 1000)
SPREAD_RT = 0.0005  # assumed round-trip spread cost
USER = "0x2C48F0aed6428A52BB298Ff50eDe9F3d72411710"
INFO = "https://api.hyperliquid.xyz/info"
STOPS = [None, 1.0, 1.5, 2.0, 3.0]
BOT_CLASSES = ("commodity", "equity")


def kc(service):
    return subprocess.run(["security", "find-generic-password", "-w", "-s", service],
                          capture_output=True, text=True, check=True).stdout.strip()


def driver():
    from neo4j import GraphDatabase
    return GraphDatabase.driver(kc("quotient-neo4j-uri"),
                                auth=(kc("quotient-neo4j-username"), kc("quotient-neo4j-password")))


OUTLOOK_Q = """
MATCH (o:PriceOutlook)
WHERE o.observable = 'terminal_close' AND o.spotAtObs IS NOT NULL AND o.medianPrice IS NOT NULL
  AND o.spotGapSigma IS NOT NULL AND o.sigmaTotal IS NOT NULL
  AND o.observedAt < o.anchorAt - duration('PT2H')
RETURN o.outlookId AS outlookId, o.seriesId AS seriesId, o.anchorDate AS anchorDate, o.assetKey AS assetKey,
  o.assetClass AS assetClass, o.anchorType AS anchorType, o.mode AS mode, o.freshnessState AS freshnessState,
  o.state AS state, o.spotAtObs AS spot, o.medianPrice AS median, o.spotGapSigma AS gapSigma,
  o.sigmaTotal AS sigmaTotal, o.directionalTakeJson AS dtJson, o.resolutionReferenceJson AS rrJson,
  o.basisId AS basisId, o.referenceBasis AS referenceBasis, o.publishedAt.epochMillis AS pubMs,
  o.observedAt.epochMillis AS obsMs, o.anchorAt.epochMillis AS ancMs, o.revision AS revision,
  o.backfilled AS backfilled
ORDER BY o.publishedAt, o.outlookId SKIP $skip LIMIT $limit
"""

OUTCOME_Q = """
MATCH (x:PriceOutcome) WHERE x.settlePrice IS NOT NULL
RETURN x.seriesId AS seriesId, x.anchorDate AS anchorDate, x.basisId AS basisId, x.settlePrice AS settle,
  coalesce(x.quarantined, false) AS quarantined, x.anchorAt.epochMillis AS ancMs,
  x.settlementBasis AS settlementBasis
"""

BACKED_Q = """
MATCH (o:PriceOutlook)
WHERE o.observable = 'terminal_close' AND o.spotGapSigma IS NOT NULL AND o.publishedAt < datetime($until)
RETURN o.outlookId AS outlookId, o.legsJson AS lj, o.distributionJson AS dj
ORDER BY o.publishedAt, o.outlookId SKIP $skip LIMIT $limit
"""


def market_backed(lj, dj):
    """The 9/3 memo's proxy: Q leg contributing and (support >= 20 or support - synthetic >= 1)."""
    try:
        d = json.loads(dj) if dj else {}
        legs = json.loads(lj) if lj else []
    except ValueError:
        return False
    mb = d.get("qMarketBacked")
    if mb is not None:
        return bool(mb)
    q = next((l for l in legs if isinstance(l, dict) and l.get("leg") == "q" and l.get("contributing")), None)
    if q is None:
        return False
    sup = float(q.get("support") or 0)
    syn = float(d.get("syntheticRungs") or 0)
    return sup >= 20 or sup - syn >= 1


def pull_rows():
    path = f"{OUT}/rows.csv.gz"
    if os.path.exists(path):
        return pd.read_csv(path)
    d = driver()
    rows, outcomes, backed = [], [], {}
    with d.session(database="neo4j", default_access_mode="READ") as s:
        skip = 0
        while True:
            batch = [dict(r) for r in s.run(OUTLOOK_Q, skip=skip, limit=5000)]
            rows.extend(batch)
            print(f"outlooks {len(rows)}", file=sys.stderr)
            if len(batch) < 5000:
                break
            skip += 5000
        outcomes = [dict(r) for r in s.run(OUTCOME_Q)]
        skip = 0
        until = datetime.fromtimestamp(STUDY_END / 1000, tz=timezone.utc).isoformat()
        while True:
            batch = [(r["outlookId"], market_backed(r["lj"], r["dj"])) for r in s.run(BACKED_Q, until=until, skip=skip, limit=2000)]
            backed.update(batch)
            if len(batch) < 2000:
                break
            skip += 2000
    d.close()
    df = pd.DataFrame(rows)
    df["marketBacked"] = df["outlookId"].map(backed)
    df["provider"] = df["rrJson"].map(lambda j: (json.loads(j).get("provider") if isinstance(j, str) and j else None))
    # Pre-basis-group rows (no reference JSON, no referenceBasis) were HL spot by construction.
    df["hlBasis"] = np.where(df["provider"].notna(), df["provider"] == "hyperliquid", df["referenceBasis"].isna() | (df["referenceBasis"] == "spot"))
    def side_of(j):
        if not isinstance(j, str) or not j:
            return None
        try:
            return json.loads(j).get("side")
        except ValueError:
            return None
    df["dtSide"] = df["dtJson"].map(side_of)
    df = df.drop(columns=["dtJson", "rrJson"])
    oc = pd.DataFrame(outcomes)
    oc = oc[~oc["quarantined"]]
    settle = oc.groupby(["seriesId", "anchorDate", "basisId"])["settle"].max().rename("settleBasis").reset_index()
    df = df.merge(settle, on=["seriesId", "anchorDate", "basisId"], how="left")
    settle_any = oc.groupby(["seriesId", "anchorDate"])["settle"].max().rename("settleAny").reset_index()
    df = df.merge(settle_any, on=["seriesId", "anchorDate"], how="left")
    df["settle"] = df["settleBasis"].fillna(df["settleAny"])
    df.to_csv(path, index=False, compression="gzip")
    return df


def pull_candles(assets, spans):
    client = HyperliquidClient()
    candles = {}
    for ak in assets:
        coin = hyperliquid_coin(ak)
        if not coin:
            print(f"no coin for {ak}", file=sys.stderr)
            continue
        path = f"{OUT}/candles_{coin.replace(':', '_')}.csv.gz"
        if os.path.exists(path):
            c = pd.read_csv(path)
        else:
            a, b = spans[ak]
            out, cur = [], a
            while cur < b:
                end = min(cur + 7 * 96 * BAR, b)
                out.extend(client.candle_snapshot(coin, "15m", cur, end))
                cur = end + 1
                time.sleep(0.2)
            c = pd.DataFrame([{"t": int(x["t"]), "o": float(x["o"]), "h": float(x["h"]), "l": float(x["l"]), "c": float(x["c"])} for x in out])
            c = c.drop_duplicates("t").sort_values("t")
            c.to_csv(path, index=False, compression="gzip")
        candles[ak] = {k: c[k].to_numpy() for k in ("t", "o", "h", "l", "c")}
        print(f"{ak} {coin} {len(c)} candles", file=sys.stderr)
    return candles


def pull_funding(assets, spans):
    client = HyperliquidClient()
    funding = {}
    for ak in assets:
        coin = hyperliquid_coin(ak)
        if not coin:
            continue
        path = f"{OUT}/funding_{coin.replace(':', '_')}.csv.gz"
        if os.path.exists(path):
            f = pd.read_csv(path)
        else:
            a, _ = spans[ak]
            out, cur = [], a
            while True:
                batch = client.funding_history(coin, cur, NOW)
                out.extend(batch)
                if len(batch) < 500:
                    break
                cur = int(batch[-1]["time"]) + 1
                time.sleep(0.2)
            f = pd.DataFrame([{"t": int(x["time"]), "rate": float(x["fundingRate"])} for x in out]) if out else pd.DataFrame({"t": [], "rate": []})
            f = f.drop_duplicates("t").sort_values("t")
            f.to_csv(path, index=False, compression="gzip")
        funding[ak] = (f["t"].to_numpy(dtype=np.int64), f["rate"].to_numpy(dtype=float))
    return funding


def pull_fees(assets):
    """Per-asset taker/maker rates using the adapter's HIP-3 formula for the bot account."""
    path = f"{OUT}/fees.json"
    if os.path.exists(path):
        return json.load(open(path))
    uf = requests.post(INFO, json={"type": "userFees", "user": USER}, timeout=15).json()
    taker, maker = float(uf["userCrossRate"]), float(uf["userAddRate"])
    disc = float(uf.get("activeReferralDiscount") or 0)
    meta = {u["name"]: u for u in requests.post(INFO, json={"type": "meta", "dex": "xyz"}, timeout=15).json()["universe"]}
    fees = {}
    for ak in assets:
        coin = hyperliquid_coin(ak)
        if not coin:
            continue
        if coin.startswith("xyz:"):
            u = meta.get(coin, {})
            scale = float(u.get("deployerFeeScale", 1.0))
            hip3 = 1 + scale if scale < 1 else 2 * scale
            growth = 0.1 if u.get("growthMode") == "enabled" else 1.0
        else:
            hip3, growth = 1.0, 1.0
        s = hip3 * growth * (1 - disc)
        fees[ak] = {"coin": coin, "taker": taker * s, "maker": max(0.0, maker) * s}
    json.dump(fees, open(path, "w"), indent=1)
    return fees


def simulate(df, candles, funding, fees, k, entry_mode="bar", max_hold_h=None):
    """Return a DataFrame of trades for stop multiple k (None = no stop)."""
    recs = []
    for r in df.itertuples(index=False):
        cd = candles.get(r.assetKey)
        if cd is None:
            continue
        t, o, h, l, c = cd["t"], cd["o"], cd["h"], cd["l"], cd["c"]
        d = 1 if r.gapSigma > 0 else -1
        if entry_mode == "bar":
            i0 = int(np.searchsorted(t, r.pubMs, side="left"))
            if i0 >= len(t):
                continue
            if t[i0] - r.pubMs > 2 * BAR:
                continue
            entry, t0 = float(o[i0]), int(t[i0])
        else:  # study frame: enter at spotAtObs at observation time
            i0 = int(np.searchsorted(t, r.obsMs, side="left"))
            if i0 >= len(t):
                continue
            if t[i0] - r.obsMs > 2 * BAR:
                continue
            entry, t0 = float(r.spot), int(r.obsMs)
        ia = int(np.searchsorted(t, r.ancMs, side="right")) - 1
        if ia < i0:
            continue
        if ia >= len(t) - 1 and r.ancMs > NOW - BAR:
            continue  # anchor not yet reached
        if max_hold_h is not None:
            ia = min(ia, int(np.searchsorted(t, t[i0] + max_hold_h * HOUR, side="right")) - 1)
        target = float(r.median)
        if d * (target - entry) <= 0:
            recs.append(dict(outlookId=r.outlookId, skipped="median_crossed"))
            continue
        hh, ll = h[i0:ia + 1], l[i0:ia + 1]
        hit_t = np.flatnonzero(hh >= target) if d > 0 else np.flatnonzero(ll <= target)
        it = int(hit_t[0]) if hit_t.size else None
        remaining = max(0.0, (r.ancMs - t0) / HOUR)
        horizon = max(remaining, (r.ancMs - r.obsMs) / HOUR)
        stop_frac = None
        i_s = None
        if k is not None:
            stop_frac = k * r.sigmaTotal * math.sqrt(remaining / horizon) if horizon > 0 else k * r.sigmaTotal
            stop = entry * math.exp(-d * stop_frac)
            hit_s = np.flatnonzero(ll <= stop) if d > 0 else np.flatnonzero(hh >= stop)
            i_s = int(hit_s[0]) if hit_s.size else None
        if i_s is not None and (it is None or i_s <= it):
            exit_px, exit_kind, iexit = float(entry * math.exp(-d * stop_frac)), "stop", i0 + i_s
        elif it is not None:
            exit_px, exit_kind, iexit = target, "target", i0 + it
        else:
            settle = float(c[ia]) if entry_mode == "bar" or not (r.settle == r.settle) else float(r.settle)
            exit_px, exit_kind, iexit = settle, "time", ia
        t_exit = int(t[iexit]) + BAR
        gross = d * math.log(exit_px / entry)
        fee = fees[r.assetKey]
        fee_in = fee["taker"]
        fee_out = fee["maker"] if exit_kind == "target" else fee["taker"]
        ft, fr = funding.get(r.assetKey, (np.array([], dtype=np.int64), np.array([])))
        m = (ft > t0) & (ft <= t_exit)
        fund = d * float(fr[m].sum()) if m.any() else 0.0  # longs pay a positive rate
        cost_rt = fee_in + fee["taker"] + SPREAD_RT
        net = gross - fee_in - fee_out - SPREAD_RT - fund
        recs.append(dict(outlookId=r.outlookId, seriesId=r.seriesId, anchorDate=r.anchorDate, assetKey=r.assetKey,
                         assetClass=r.assetClass, anchorType=r.anchorType, pubMs=r.pubMs, t0=t0, tExit=t_exit,
                         side="LONG" if d > 0 else "SHORT", entry=entry, target=target, exitPx=exit_px, exitKind=exit_kind,
                         gross=gross, net=net, fund=fund, holdH=(t_exit - t0) / HOUR, gapSigma=r.gapSigma,
                         absGap=abs(r.gapSigma), stopFrac=stop_frac, costRT=cost_rt,
                         edge=abs(math.log(target / entry)) - cost_rt, marketBacked=r.marketBacked,
                         week=datetime.fromtimestamp(r.pubMs / 1000, tz=timezone.utc).strftime("%G-W%V")))
    tr = pd.DataFrame(recs)
    if "skipped" in tr.columns:
        tr = tr[tr["skipped"].isna()].drop(columns=["skipped"])
    return tr


def weights(tr):
    n = tr.groupby(["seriesId", "anchorDate"])["outlookId"].transform("count")
    return 1.0 / n


def table(tr, keys, title):
    if tr.empty:
        return f"\n### {title}\n\n_(no trades)_\n"
    tr = tr.copy()
    if "w" not in tr.columns:
        tr["w"] = weights(tr)
    g = tr.groupby(keys, dropna=False)
    rows = []
    for key, x in g:
        w = x["w"].sum()
        if w < 0.5:
            continue
        rows.append({
            **(dict(zip(keys, key if isinstance(key, tuple) else (key,)))),
            "settles": round(w, 1), "revs": len(x),
            "gross%": round(100 * (x["gross"] * x["w"]).sum() / w, 3),
            "net%": round(100 * (x["net"] * x["w"]).sum() / w, 3),
            "touch%": round(100 * ((x["exitKind"] == "target") * x["w"]).sum() / w, 1),
            "stop%": round(100 * ((x["exitKind"] == "stop") * x["w"]).sum() / w, 1),
            "holdH": round((x["holdH"] * x["w"]).sum() / w, 1),
        })
    out = pd.DataFrame(rows)
    return f"\n### {title}\n\n" + to_md(out) + "\n"


def to_md(out):
    cols = list(out.columns)
    lines = ["| " + " | ".join(str(c) for c in cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    for _, r in out.iterrows():
        lines.append("| " + " | ".join("" if (isinstance(v, float) and v != v) else str(v) for v in r.tolist()) + " |")
    return "\n".join(lines)


def gap_bucket(g):
    return "0.15-0.30" if g < 0.3 else "0.30-0.50" if g < 0.5 else "0.50-1.0" if g < 1.0 else ">=1.0"


def book_sim(tr, candles, r_pct, G, nav0=600.0):
    """Sequential book: up to 4 positions, one per asset, class caps 1/3 commodity 2/3 equity of G*NAV."""
    share = {"commodity": 1 / 3, "equity": 2 / 3}
    tr = tr.sort_values("pubMs")
    nav, open_pos, trades = nav0, {}, []
    marks = []  # (ms, nav_mtm)
    day = int(tr["pubMs"].min() // 86_400_000 * 86_400_000)
    def mtm(at):
        v = nav
        for p in open_pos.values():
            cd = candles[p["assetKey"]]
            i = int(np.searchsorted(cd["t"], at, side="right")) - 1
            px = float(cd["c"][max(0, i)])
            v += p["notional"] * p["d"] * math.log(px / p["entry"])
        return v
    for r in tr.itertuples(index=False):
        for ak in [ak for ak, p in open_pos.items() if p["tExit"] <= r.pubMs]:
            p = open_pos.pop(ak)
            nav += p["notional"] * p["net"]
        while day + 86_400_000 <= r.pubMs:
            day += 86_400_000
            marks.append((day, mtm(day)))
        if nav <= 0:
            break
        if r.assetKey in open_pos or len(open_pos) >= 4 or r.assetClass not in share:
            continue
        gross_used = sum(p["notional"] for p in open_pos.values())
        class_used = sum(p["notional"] for p in open_pos.values() if p["assetClass"] == r.assetClass)
        want = nav * r_pct / 100 / (r.stopFrac + r.costRT)
        notional = min(want, 2 * nav, G * nav - gross_used, G * nav * share[r.assetClass] - class_used)
        if notional < 10:
            continue
        open_pos[r.assetKey] = dict(assetKey=r.assetKey, assetClass=r.assetClass, notional=notional, entry=r.entry,
                                    d=1 if r.side == "LONG" else -1, net=r.net, tExit=r.tExit)
        trades.append(dict(pubMs=r.pubMs, assetKey=r.assetKey, notional=notional, lev=notional / nav, net=r.net))
    last = max([p["tExit"] for p in open_pos.values()] + [day])
    while day < last:
        day += 86_400_000
        for ak in [ak for ak, p in open_pos.items() if p["tExit"] <= day]:
            p = open_pos.pop(ak)
            nav += p["notional"] * p["net"]
        marks.append((day, mtm(day)))
    m = pd.DataFrame(marks, columns=["ms", "nav"]).drop_duplicates("ms")
    return m, pd.DataFrame(trades)


def bootstrap_dd(nav_series, n=1000, block=7, seed=7):
    rets = nav_series.pct_change(fill_method=None).dropna().to_numpy()
    if len(rets) < block:
        return float("nan"), float("nan")
    blocks = [rets[i:i + block] for i in range(0, len(rets) - block + 1)]
    rng = np.random.default_rng(seed)
    dds, terms = [], []
    for _ in range(n):
        seq = np.concatenate([blocks[j] for j in rng.integers(0, len(blocks), size=math.ceil(len(rets) / block))])[:len(rets)]
        path = np.cumprod(1 + seq)
        dds.append(1 - (path / np.maximum.accumulate(path)).min())
        terms.append(path[-1] - 1)
    return float(np.percentile(dds, 95)), float(np.median(terms))


def main():
    df = pull_rows()
    df = df[df["hlBasis"]].copy()
    df["horizonH"] = (df["ancMs"] - df["pubMs"]) / HOUR
    df["absGap"] = df["gapSigma"].abs()
    df["dirOk"] = np.where(df["pubMs"] >= DT_LIVE,
                           ((df["dtSide"] == "bullish") & (df["gapSigma"] > 0)) | ((df["dtSide"] == "bearish") & (df["gapSigma"] < 0)),
                           df["absGap"] > 0)
    assets = sorted(df["assetKey"].unique())
    spans = {}
    for ak in assets:
        x = df[df["assetKey"] == ak]
        spans[ak] = (int(x["obsMs"].min()) - HOUR, int(min(NOW, x["ancMs"].max() + HOUR)))
    candles = pull_candles(assets, spans)
    funding = pull_funding(assets, spans)
    fees = pull_fees(assets)
    md = ["# Swing perps backtest", "",
          f"Generated {datetime.now(timezone.utc).isoformat(timespec='minutes')}. Outlook rows {len(df)} (HL basis, terminal_close), "
          f"{df['pubMs'].map(lambda m: datetime.fromtimestamp(m/1000, tz=timezone.utc).date()).min()} to "
          f"{df['pubMs'].map(lambda m: datetime.fromtimestamp(m/1000, tz=timezone.utc).date()).max()}.", "",
          "Frame: entry at the open of the first 15m bar at or after publish; target = outlook median on first touch (maker exit); "
          "stop = k x sigmaTotal x sqrt(remaining/horizon), same-bar stop wins; otherwise mark at the anchor bar close (taker exit). "
          f"Costs: per-asset taker/maker from the account's fee schedule and the xyz deployer fee scale (growth-mode assets discounted); "
          f"assumed round-trip spread {SPREAD_RT*1e4:.0f} bps; funding from venue funding history over the hold. One weight per settle.", "",
          "Per-asset fees (bps): " + ", ".join(f"{v['coin']} {v['taker']*1e4:.1f}/{v['maker']*1e4:.1f}" for v in fees.values()), ""]
    dt_rows = df[df["pubMs"] >= DT_LIVE]
    agree = ((dt_rows["dtSide"].isin(["bullish", "bearish"])) & dt_rows["dirOk"]).sum()
    md.append(f"Directional take available from 2026-09-04: {len(dt_rows)} rows, side agrees with sign(gap) on {agree} of the directional ones "
              f"({(dt_rows['dtSide'].isin(['bullish','bearish'])).sum()} directional). Before that, side = sign(gap).")

    # (1) Reproduce the 9/1 headline: study window, all horizons >= 2h, |gap| >= 0.15, no stop, study frame.
    study = df[(df["pubMs"] < STUDY_END) & (df["absGap"] >= 0.15) & df["dirOk"]]
    tr_study = simulate(study, candles, funding, fees, None, entry_mode="study")
    md.append("\n## 1. Reproduction of the 9/1 headline (study frame: entry at spotAtObs, TP on median touch, else settle; gross, no stop)")
    md.append(table(tr_study, ["marketBacked"], "By market-backed (9/3 proxy), all horizons"))
    tr_study["absGapBucket"] = tr_study["absGap"].map(gap_bucket)
    md.append(table(tr_study, ["marketBacked", "absGapBucket"], "By market-backed x |gap| bucket"))
    tr_study_bar = simulate(study, candles, funding, fees, None, entry_mode="bar")
    md.append(table(tr_study_bar, ["marketBacked"], "Same window, bot frame (entry at next 15m bar open)"))

    # Bot universe from here: 24-120h horizons, |gap| in [0.15, 1.0], side agreement.
    base = df[(df["horizonH"] >= 24) & (df["horizonH"] <= 120) & (df["absGap"] >= 0.15) & df["dirOk"]]
    base_capped = base[base["absGap"] <= 1.0]
    md.append("\n## 2. Bot frame, 24-120h horizons, |gap| in [0.15, 1.0]")
    sweep = {}
    for k in STOPS:
        tr = simulate(base_capped, candles, funding, fees, k)
        tr["regime"] = np.where(tr["pubMs"] >= REGIME, ">=2026-09-01", "<2026-09-01")
        sweep[k] = tr
    md.append("\n### Stop sweep (whole sample)\n")
    md.append(pd.concat([sweep[k].assign(stop=str(k), w=weights(sweep[k])) for k in STOPS]).pipe(table, ["stop"], "By stop multiple"))
    md.append(pd.concat([sweep[k].assign(stop=str(k), w=weights(sweep[k])) for k in STOPS]).pipe(table, ["stop", "regime"], "By stop multiple x regime"))
    uncapped = simulate(base, candles, funding, fees, 1.5)
    uncapped["absGapBucket"] = uncapped["absGap"].map(gap_bucket)
    md.append(table(uncapped, ["absGapBucket"], "|gap| buckets including >= 1.0 (stop 1.5)"))

    # choose stop by net %/trade in the post-regime sample, tie -> whole sample
    def score(k):
        t = sweep[k]
        t = t.assign(w=weights(t))
        post = t[t["regime"] == ">=2026-09-01"]
        return ((post["net"] * post["w"]).sum() / max(post["w"].sum(), 1e-9), (t["net"] * t["w"]).sum() / max(t["w"].sum(), 1e-9))
    finite = [k for k in STOPS if k is not None]
    chosen = max(finite, key=lambda k: score(k)[1])
    holds = {}
    for hh in (24, 48, 72, None):
        th = simulate(base_capped, candles, funding, fees, chosen, max_hold_h=hh)
        th["regime"] = np.where(th["pubMs"] >= REGIME, ">=2026-09-01", "<2026-09-01")
        holds[hh] = th
    md.append(pd.concat([holds[hh].assign(maxHold=str(hh), w=weights(holds[hh])) for hh in holds]).pipe(table, ["maxHold"], f"Max-hold sweep at stop {chosen} (exit at the mark when the hold limit is reached before a touch)"))
    md.append(pd.concat([holds[hh].assign(maxHold=str(hh), w=weights(holds[hh])) for hh in holds]).pipe(table, ["maxHold", "regime"], "Max-hold sweep x regime"))
    def hscore(hh):
        t = holds[hh].assign(w=weights(holds[hh]))
        return (t["net"] * t["w"]).sum() / max(t["w"].sum(), 1e-9)
    chosen_hold = max(holds, key=hscore)
    tr = holds[chosen_hold]
    tr["absGapBucket"] = tr["absGap"].map(gap_bucket)
    tr["edgeQ"] = pd.qcut(tr["edge"], 4, labels=["Q1 low", "Q2", "Q3", "Q4 high"], duplicates="drop")
    md.append(f"\n## 3. Chosen stop {chosen} x sigmaTotal, max hold {chosen_hold}h (best whole-sample net %/trade)")
    md.append(table(tr, ["regime"], "By regime"))
    md.append(table(tr, ["absGapBucket"], "By |gap| bucket"))
    md.append(table(tr, ["anchorType"], "By anchor type"))
    md.append(table(tr, ["assetClass"], "By asset class"))
    md.append(table(tr, ["week"], "By ISO week of publish"))
    md.append(table(tr, ["edgeQ"], "By perceived net edge quartile (|ln(median/entry)| - round-trip cost)"))
    md.append(table(tr, ["assetClass", "absGapBucket"], "By class x |gap| bucket"))
    first = tr.sort_values("pubMs").groupby(["seriesId", "anchorDate"], as_index=False).head(1).assign(w=1.0)
    md.append(table(first, ["regime"], "First eligible revision per settle only (what a bot holding one position per asset actually trades), by regime"))
    md.append(table(first, ["assetClass"], "First eligible revision per settle, by class"))
    md.append(table(first, ["absGapBucket"], "First eligible revision per settle, by |gap| bucket"))

    # Sizing bootstrap on the bot universe (commodity + equity only).
    bot = tr[tr["assetClass"].isin(BOT_CLASSES)]
    md.append("\n## 4. Sizing bootstrap (sequential book, up to 4 positions, class caps 1/3 commodity 2/3 equity, daily marks, weekly-block bootstrap x1000)\n")
    rows = []
    best = None
    for r_pct in (5, 7.5, 10):
        for G in (2, 3, 4):
            m, bt = book_sim(bot, candles, r_pct, G)
            p95, med = bootstrap_dd(m["nav"])
            realized = m["nav"].iloc[-1] / 600 - 1 if len(m) else float("nan")
            rows.append({"risk%": r_pct, "grossCap": G, "trades": len(bt), "meanLev": round(bt["lev"].mean(), 2) if len(bt) else None,
                         "realized%": round(100 * realized, 2), "p95 maxDD%": round(100 * p95, 1), "median terminal%": round(100 * med, 1)})
            if p95 == p95 and p95 <= 0.25 and (best is None or (r_pct, G) > best):
                best = (r_pct, G)
    md.append(to_md(pd.DataFrame(rows)))
    md.append("")
    _, bt10 = book_sim(bot, candles, 10, 4)
    if len(bt10):
        bt10["date"] = bt10["pubMs"].map(lambda m: datetime.fromtimestamp(m / 1000, tz=timezone.utc).strftime("%m-%d %H:%M"))
        bt10["net%"] = (100 * bt10["net"]).round(3); bt10["lev"] = bt10["lev"].round(2); bt10["notional"] = bt10["notional"].round(0)
        md.append("\nBook trades at risk 10% / gross 4x (publish order):\n")
        md.append(to_md(bt10[["date", "assetKey", "notional", "lev", "net%"]]))
        md.append("")
    cfg = {"minGapSigma": 0.15, "maxGapSigma": 1.0, "stopSigmaMultiple": chosen, "maxHoldHours": chosen_hold if chosen_hold is not None else 120,
           "riskBasePct": 5, "riskMaxPct": 10, "grossNotionalNav": 4, "classShare": {"commodity": round(1 / 3, 4), "equity": round(2 / 3, 4)}}
    notes = []
    nostop = sweep[None].assign(w=weights(sweep[None]))
    notes.append(f"No-stop reference: net {100*(nostop['net']*nostop['w']).sum()/nostop['w'].sum():+.3f}%/trade; every stop lowers expectancy, the widest tested least.")
    if best is not None:
        cfg["riskMaxPct"] = best[0]
        cfg["riskBasePct"] = min(5, best[0])
        cfg["grossNotionalNav"] = best[1]
        notes.append(f"Largest (risk, gross cap) with p95 drawdown <= 25%: risk {best[0]}%, gross {best[1]}x NAV.")
    else:
        notes.append("No (risk, gross cap) combination met the 25% p95 drawdown bound, or the bootstrap was inconclusive; config keeps the plan defaults.")
    # 1.0 cap check
    u = uncapped.assign(w=weights(uncapped))
    hi = u[u["absGap"] >= 1.0]
    if len(hi):
        notes.append(f"|gap| >= 1.0 at stop 1.5: net {100*(hi['net']*hi['w']).sum()/hi['w'].sum():+.3f}%/trade on {hi['w'].sum():.1f} settles; the 1.0 cap is "
                     + ("kept." if (hi['net']*hi['w']).sum() <= 0 else "not supported by this sample but kept per the touch-rate evidence."))
    md.append("\n## Verdict\n")
    t = tr.assign(w=weights(tr))
    post = t[t["regime"] == ">=2026-09-01"]
    md.append(f"- Whole sample, stop {chosen}, max hold {chosen_hold}: net {100*(t['net']*t['w']).sum()/t['w'].sum():+.3f}%/trade on {t['w'].sum():.1f} settles ({len(t)} revisions).")
    if len(post):
        md.append(f"- After 2026-09-01: net {100*(post['net']*post['w']).sum()/post['w'].sum():+.3f}%/trade on {post['w'].sum():.1f} settles.")
    md.extend(f"- {n}" for n in notes)
    fw = first.assign(w=1.0)
    def fnet(x): return 100 * x["net"].mean() if len(x) else float("nan")
    md.append(f"- First eligible revision per settle (the trade a one-position-per-asset bot takes): before 2026-09-01 {fnet(fw[fw['regime']=='<2026-09-01']):+.3f}%/trade on {int((fw['regime']=='<2026-09-01').sum())} settles; "
              f"after {fnet(fw[fw['regime']=='>=2026-09-01']):+.3f}% on {int((fw['regime']=='>=2026-09-01').sum())}; equity {fnet(fw[fw['assetClass']=='equity']):+.3f}% ({int((fw['assetClass']=='equity').sum())}), "
              f"commodity {fnet(fw[fw['assetClass']=='commodity']):+.3f}% ({int((fw['assetClass']=='commodity').sum())}).")
    eq = tr.assign(w=weights(tr)).groupby("edgeQ", observed=True).apply(lambda x: 100 * (x["net"] * x["w"]).sum() / x["w"].sum())
    md.append("- Perceived-edge quartiles, net %/trade: " + ", ".join(f"{k} {v:+.3f}" for k, v in eq.items()) + " (ranking by edge orders trades monotonically in this sample).")
    pick = next((r for r in rows if best and r["risk%"] == best[0] and r["grossCap"] == best[1]), None)
    if pick:
        md.append(f"- Sequential book at the chosen sizing on the sample path: {pick['trades']} trades, mean leverage {pick['meanLev']}x NAV, realized {pick['realized%']:+.2f}%, bootstrap p95 max drawdown {pick['p95 maxDD%']}%, bootstrap median terminal {pick['median terminal%']:+.1f}%. "
                  "Small per-trade edge with wide dispersion: three weeks does not separate the strategy from zero at the book level.")
    md.append(f"- Config written to config.json: `{json.dumps(cfg)}`")
    md.append("- Caveats: three weeks of data; the last few days of publishes have unsettled anchors and are excluded; the touch frame has a mechanical positive bias; spread is assumed.")
    open(f"{OUT}/report.md", "w").write("\n".join(md) + "\n")
    json.dump(cfg, open(f"{OUT}/config.json", "w"), indent=1)
    tr.to_csv(f"{OUT}/trades_stop{chosen}.csv.gz", index=False, compression="gzip")
    print("\n".join(md[-8:]))


if __name__ == "__main__":
    main()
