#!/bin/bash
# Full browser-equivalent flow against the running server, repeated, to gauge reliability.
BASE=http://localhost:5177
KW="${1:-周杰伦}"
N="${2:-5}"
ok=0
for i in $(seq 1 "$N"); do
  curl -s "$BASE/api/search?keyword=$(node -e "process.stdout.write(encodeURIComponent('$KW'))")&limit=5" -o /tmp/s.json
  node -e "const d=require('/tmp/s.json');require('fs').writeFileSync('/tmp/m.json',JSON.stringify({musicInfo:d.list[Math.floor(Math.random()*Math.min(5,d.list.length))]}))"
  curl -s -X POST "$BASE/api/url" -H 'Content-Type: application/json' -d @/tmp/m.json -o /tmp/u.json
  line=$(node -e "const u=require('/tmp/u.json');const m=require('/tmp/m.json').musicInfo;process.stdout.write(m.name+' | src='+(u.sourceScript||'-')+' validated='+u.validated)")
  # verify proxy delivers real audio
  purl="$BASE$(node -e "process.stdout.write(require('/tmp/u.json').proxied||'')")"
  if [ -n "$(node -e "process.stdout.write(require('/tmp/u.json').url?'1':'')")" ]; then
    curl -s -r 0-3 "$purl" -o /tmp/a.bin
    audio=$(node -e "const b=require('fs').readFileSync('/tmp/a.bin');process.stdout.write((b[0]===0x49&&b[1]===0x44&&b[2]===0x33)||(b[0]===0xff&&(b[1]&0xe0)===0xe0)?'AUDIO':'NOT-AUDIO')")
  else
    audio="NO-URL"
  fi
  echo "[$i] $line  proxy=$audio"
  [ "$audio" = "AUDIO" ] && ok=$((ok+1))
done
echo "RESULT: $ok/$N playable"
