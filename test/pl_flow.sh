#!/bin/bash
BASE=http://localhost:5177
tok() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).token||'')}catch(e){}})"; }
AT=$(curl -s -X POST $BASE/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"password"}' | tok)

echo "1. 当前歌单列表:"
curl -s $BASE/api/playlists -H "Authorization: Bearer $AT" > /tmp/pl.json
node -e "const p=require('/tmp/pl.json').playlists;console.log('   '+p.map(x=>x.name+'(id'+x.id+',默认'+x.isDefault+','+x.count+'首)').join(' | '))"

echo "2. 新建歌单「华语经典」:"
curl -s -X POST $BASE/api/playlists -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{"name":"华语经典"}' > /tmp/new.json
NID=$(node -e "console.log(require('/tmp/new.json').playlist.id)")
echo "   新歌单 id=$NID"

echo "3. 往「华语经典」加2首:"
curl -s -o /dev/null -X POST $BASE/api/playlists/$NID/songs -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{"song":{"source":"kg","songmid":"X1","name":"晴天","singer":"周杰伦"}}'
curl -s -X POST $BASE/api/playlists/$NID/songs -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{"song":{"source":"kg","songmid":"X2","name":"稻香","singer":"周杰伦"}}' > /tmp/a.json
node -e "console.log('   数量='+require('/tmp/a.json').count)"

echo "4. 去重测试(再加一次晴天):"
curl -s -X POST $BASE/api/playlists/$NID/songs -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{"song":{"source":"kg","songmid":"X1","name":"晴天","singer":"周杰伦"}}' > /tmp/d.json
node -e "console.log('   数量仍='+require('/tmp/d.json').count+' (应为2)')"

echo "5. 取详情:"
curl -s $BASE/api/playlists/$NID -H "Authorization: Bearer $AT" > /tmp/det.json
node -e "const p=require('/tmp/det.json').playlist;console.log('   '+p.name+': '+p.songs.map(x=>x.name).join('、'))"

echo "6. 删除「晴天」:"
curl -s -X DELETE "$BASE/api/playlists/$NID/songs?key=kg:X1" -H "Authorization: Bearer $AT" > /tmp/r.json
node -e "console.log('   删后数量='+require('/tmp/r.json').count)"

echo "7. 删默认歌单(应失败):"
curl -s -X DELETE $BASE/api/playlists/1 -H "Authorization: Bearer $AT" > /tmp/dd.json
node -e "const j=require('/tmp/dd.json');console.log('   '+(j.error||'被删了?!'))"

echo "8. 删「华语经典」(应成功):"
curl -s -o /dev/null -w '   http=%{http_code}\n' -X DELETE $BASE/api/playlists/$NID -H "Authorization: Bearer $AT"

echo "9. 最终列表:"
curl -s $BASE/api/playlists -H "Authorization: Bearer $AT" > /tmp/fin.json
node -e "const p=require('/tmp/fin.json').playlists;console.log('   '+p.map(x=>x.name+'('+x.count+'首)').join(' | '))"
