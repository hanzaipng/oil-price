#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GitHub Actions 用：抓取全国 31 省油价，更新仓库里的 data.js。

- 只用 Python 标准库，不需要安装依赖。
- 默认使用公共接口 ID/KEY；可在仓库 Secrets 里配置 OIL_API_ID / OIL_API_KEY。
- 某个省失败时保留旧数据；成功数据少于 20 个省则报错退出，避免把页面写坏。
- 自动识别 data.js 在根目录、site/data.js 或 docs/data.js。
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://cn.apihz.cn/api/jinrong/youjia.php"
API_ID = os.environ.get("OIL_API_ID") or "88888888"
API_KEY = os.environ.get("OIL_API_KEY") or "88888888"

PROVINCES = [
    "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
    "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南",
    "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州",
    "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆",
]

PRICE_KEYS = {
    "92", "95", "98", "89", "e92", "e95", "e98",
    "ap95", "ap98", "0h", "10h", "20h", "35h", "zyk", "cng", "lng", "lcng",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OilScope/1.0",
    "Referer": "https://www.apihz.cn/",
}

SSL_CTX = ssl.create_default_context()


def has_price(province):
    for zone in (province.get("data") or {}).values():
        for key in PRICE_KEYS:
            value = zone.get(key)
            if value not in (None, "", 0):
                return True
    return False


def date_key(text):
    match = re.search(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})", str(text or ""))
    return int(match.group(1) + match.group(2).zfill(2) + match.group(3).zfill(2)) if match else 0


def pick_target():
    for name in ("data.js", "site/data.js", "docs/data.js"):
        if os.path.exists(name):
            return name
    return "data.js"


def load_snapshot(path):
    if not os.path.exists(path):
        return None
    text = open(path, encoding="utf-8").read()
    match = re.search(r"window\.OIL_SNAPSHOT\s*=\s*(\{.*\})\s*;", text, re.S)
    if not match:
        print("WARN: 无法解析现有 data.js，将从空数据开始")
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        print("WARN: data.js JSON 解析失败：", exc)
        return None


def call(province, timeout=30):
    query = urllib.parse.urlencode({"id": API_ID, "key": API_KEY, "sheng": province})
    req = urllib.request.Request(API + "?" + query, headers=HEADERS)
    with urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="只抓前 N 个省，用于测试")
    args = parser.parse_args()

    target = pick_target()
    snapshot = load_snapshot(target) or {}
    provinces = snapshot.get("provinces") or {}
    print(f"target={target}, existing={len(provinces)} provinces")

    names = PROVINCES[: args.limit] if args.limit else PROVINCES
    success = 0

    for index, name in enumerate(names, 1):
        for attempt in range(1, 9):
            try:
                data = call(name)
                if data.get("code") == 200 and has_price(data):
                    provinces[name] = data
                    success += 1
                    print(f"[{index:02d}/{len(names)}] {name} OK {data.get('date', '')}", flush=True)
                    break
                message = data.get("msg", "")
                match = re.search(r"请\s*(\d+)\s*秒", message)
                wait = min(120, int(match.group(1)) + 2) if match else 8
                print(f"[{index:02d}/{len(names)}] {name} busy: {message[:40]} wait {wait}s", flush=True)
                time.sleep(wait)
            except Exception as exc:  # noqa: BLE001
                print(f"[{index:02d}/{len(names)}] {name} ERR {exc!r}", flush=True)
                time.sleep(5)
        else:
            print(f"[{index:02d}/{len(names)}] {name} FAILED, keep old value", flush=True)
        time.sleep(2.5)

    valid = sum(1 for item in provinces.values() if has_price(item))
    print(f"success={success}, valid={valid}/{len(PROVINCES)}")
    if valid < 20:
        print("ERROR: 有效省份少于 20 个，放弃写入，保留旧数据", file=sys.stderr)
        return 1

    latest = max((p.get("date", "") for p in provinces.values()), key=date_key, default="")
    snapshot = {
        "date": latest,
        "updated": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": "接口盒子 apihz.cn",
        "provinces": provinces,
    }
    js = (
        "/* 自动生成：全国油价快照，由 GitHub Actions 更新 */\n"
        "window.OIL_SNAPSHOT = "
        + json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as file:
        file.write(js)
    os.replace(tmp, target)
    print(f"WROTE {target}: {len(js) / 1024:.1f} KB, date={latest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
