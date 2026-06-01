#!/bin/bash
BASE=http://localhost:5177
out() { echo "$@"; }

# 1) admin login
TOKEN=$(curl -s -X POST $BASE/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"password"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).token||'')}catch(e){}})")
[ -n "$TOKEN" ] && out "1. admin登录: OK (token长度 ${#TOKEN})" || { out "1. admin登录: FAIL"; exit 1; }

# 2) me
ME=$(curl -s $BASE/api/me -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).user;process.stdout.write(u.username+'/admin='+u.isAdmin)})")
out "2. /api/me: $ME"

# 3) search WITH token
SC=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/search?keyword=test&limit=2" -H "Authorization: Bearer $TOKEN")
out "3. 带token搜索: http=$SC"

# 4) list users
U0=$(curl -s $BASE/api/admin/users -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(''+JSON.parse(s).users.length)})")
out "4. 初始成员数: $U0"

# 5) add member alice
ADD=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/admin/users -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"username":"alice","password":"alice123"}')
out "5. 添加成员alice: http=$ADD"

# 6) alice can login + is not admin
ATOKEN=$(curl -s -X POST $BASE/api/login -H 'Content-Type: application/json' -d '{"username":"alice","password":"alice123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).token||'')}catch(e){}})")
[ -n "$ATOKEN" ] && out "6. alice登录: OK" || out "6. alice登录: FAIL"

# 7) alice CANNOT manage users (expect 403)
A403=$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/admin/users -H "Authorization: Bearer $ATOKEN")
out "7. alice访问成员管理: http=$A403 (期望403)"

# 8) alice CAN search (normal member)
A200=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/search?keyword=test&limit=2" -H "Authorization: Bearer $ATOKEN")
out "8. alice搜索: http=$A200 (期望200)"

# 9) find alice id and delete
AID=$(curl -s $BASE/api/admin/users -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).users.find(x=>x.username==='alice');process.stdout.write(u?''+u.id:'')})")
DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $BASE/api/admin/users/$AID -H "Authorization: Bearer $TOKEN")
out "9. 删除alice(id=$AID): http=$DEL"

# 10) final count
U1=$(curl -s $BASE/api/admin/users -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(''+JSON.parse(s).users.length)})")
out "10. 删除后成员数: $U1"

# 11) cannot delete last admin
DLA=$(curl -s -X DELETE $BASE/api/admin/users/1 -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.error||'deleted?!')})")
out "11. 删除自己(唯一管理员): $DLA"
