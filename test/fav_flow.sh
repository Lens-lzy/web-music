#!/bin/bash
BASE=http://localhost:5177
jtok() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).token||'')}catch(e){}})"; }
jfavn() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(''+(JSON.parse(s).favorites||[]).length)}catch(e){process.stdout.write('ERR')}})"; }
jfav1() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const f=JSON.parse(s).favorites||[];process.stdout.write(f[0]?f[0].name:'(空)')}catch(e){process.stdout.write('ERR')}})"; }

# admin
AT=$(curl -s -X POST $BASE/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"password"}' | jtok)
# create bob
curl -s -o /dev/null -X POST $BASE/api/admin/users -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{"username":"bob","password":"bob123"}'
BT=$(curl -s -X POST $BASE/api/login -H 'Content-Type: application/json' -d '{"username":"bob","password":"bob123"}' | jtok)
echo "admin/bob 登录: $([ -n "$AT" ] && echo ok) / $([ -n "$BT" ] && echo ok)"

# admin saves 2 favs
curl -s -o /dev/null -X PUT $BASE/api/favorites -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{"favorites":[{"source":"kg","songmid":"A1","name":"晴天"},{"source":"kg","songmid":"A2","name":"稻香"}]}'
# bob saves 1 different fav
curl -s -o /dev/null -X PUT $BASE/api/favorites -H "Authorization: Bearer $BT" -H 'Content-Type: application/json' -d '{"favorites":[{"source":"kg","songmid":"B1","name":"小幸运"}]}'

echo "admin 收藏数: $(curl -s $BASE/api/favorites -H "Authorization: Bearer $AT" | jfavn)  首项: $(curl -s $BASE/api/favorites -H "Authorization: Bearer $AT" | jfav1)"
echo "bob   收藏数: $(curl -s $BASE/api/favorites -H "Authorization: Bearer $BT" | jfavn)  首项: $(curl -s $BASE/api/favorites -H "Authorization: Bearer $BT" | jfav1)"

# cross check: bob must NOT see admin's 晴天
BOBHAS=$(curl -s $BASE/api/favorites -H "Authorization: Bearer $BT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=JSON.parse(s).favorites||[];process.stdout.write(f.some(x=>x.name==='晴天')?'串了!':'隔离OK')})")
echo "bob 是否看到 admin 的歌: $BOBHAS"

# delete bob, his favorites should be gone; re-create bob -> empty
BID=$(curl -s $BASE/api/admin/users -H "Authorization: Bearer $AT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).users.find(x=>x.username==='bob');process.stdout.write(u?''+u.id:'')})")
curl -s -o /dev/null -X DELETE $BASE/api/admin/users/$BID -H "Authorization: Bearer $AT"
echo "已删除 bob(id=$BID)"
