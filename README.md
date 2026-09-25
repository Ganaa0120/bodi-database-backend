# Bodi Financial Backend — Auth Foundation

Bodi Group-ын 15 охин компанийн санхүүгийн multi-tenant системийн backend.
Энэ бол эхний алхам: **login + role-based authorization + audit log** суурь.
Дараагийн алхмуудад company/department CRUD, dynamic form, Azure Blob upload
зэрэг нэмэгдэнэ.

## Архитектур (энэ шатанд)

- **Node.js / Express** — REST API
- **PostgreSQL** (локал дээр турших үед энгийн Postgres, production дээр Azure
  Database for PostgreSQL Flexible Server)
- **JWT access token** (30 мин) + **httpOnly cookie дахь refresh token** (7 хоног,
  ашиглах бүрд rotation хийгддэг)
- **bcrypt** нууц үг hash хийхэд (12 rounds)
- **Account lockout**: 5 удаа буруу нэвтрэхэд 15 минутаар түгждэг
- **IP-based rate limiting**: login endpoint 15 минутанд 20 хүсэлт
- **Immutable audit log**: LOGIN_SUCCESS, LOGIN_FAILED, ACCOUNT_LOCKED, LOGOUT,
  TOKEN_REFRESH бүгд бичигдэнэ

## Роль (role) бүтэц

```
super_admin   → бүх компани, бүх department-ийн дата
company (CEO) → зөвхөн өөрийн компанийн дата
department    → зөвхөн өөрийн department-ийн дата
```

`users` table дээрх `users_role_scope_chk` constraint нь эдгээр 3 role-ийн
`company_id`/`department_id`-ийн зохистой хослолыг DB түвшинд хатуу
баталгаажуулдаг (жишээ нь `super_admin` хэзээ ч `company_id`-тай байж болохгүй).

## Суулгах, ажиллуулах

### 1. Dependency суулгах

```bash
npm install
```

### 2. `.env` файл бэлдэх

```bash
cp .env.example .env
```

`.env` дотор дараах утгуудыг өөрийн орчинд тохируулж бөглөнө:

- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` — Azure Database for
  PostgreSQL Flexible Server-ийн холболтын мэдээлэл (эсвэл локал Postgres)
- `ACCESS_TOKEN_SECRET` — random урт утга үүсгэх:
  ```bash
  node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
  ```
- `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` — анхны super_admin хэрэглэгчийн
  нэвтрэх мэдээлэл (**доод тал нь 12 тэмдэгт**, seed script үүнийг шалгадаг)

### 3. Migration ажиллуулах

```bash
npm run migrate
```

### 4. Анхны super_admin хэрэглэгч үүсгэх

```bash
npm run seed:super-admin
```

Ажилласны дараа **`.env`-с `SUPER_ADMIN_PASSWORD`-г устгахыг зөвлөж байна** —
DB-д зөвхөн bcrypt hash нь үлдэнэ, plaintext нууц үг цаашид хаана ч хадгалагдах
шаардлагагүй.

### 5. Сервер ажиллуулах

```bash
npm run dev    # nodemon-той, development
npm start      # production
```

Сервер `http://localhost:4000` дээр ажиллана (`.env`-д `PORT` өөрчилж болно).

## API endpoint-ууд

| Method | Path | Тайлбар |
|---|---|---|
| GET | `/health` | Сервер ажиллаж байгаа эсэх |
| POST | `/api/auth/login` | `{ email, password }` → accessToken + refresh cookie |
| POST | `/api/auth/refresh` | Cookie дэх refresh token ашиглан шинэ accessToken авах |
| POST | `/api/auth/logout` | Refresh token-ийг цуцалж, cookie арилгах (auth шаардана) |
| GET | `/api/auth/me` | Одоогийн нэвтэрсэн хэрэглэгчийн мэдээлэл (auth шаардана) |
| GET | `/api/admin/ping` | super_admin эрх шалгах туршилтын endpoint |

### Жишээ: нэвтрэх

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"azzaya.d@bodigroup.mn","password":"YOUR_PASSWORD"}'
```

Хариу нь `accessToken`-г JSON body-оор, `refresh_token`-г httpOnly cookie-оор
буцаана. Дараагийн хүсэлтүүдэд:

```bash
curl http://localhost:4000/api/auth/me \
  -H "Authorization: Bearer <accessToken>"
```

## Аюулгүй байдлын шийдвэрүүд (яагаад ингэж хийсэн бэ)

- **Refresh token нь DB-д hash хэлбэрээр хадгалагдана** (sha256), plaintext биш
  — DB алдагдсан ч токенууд шууд ашиглагдахгүй.
- **Refresh token rotation**: ашиглах бүрд хуучин нь цуцлагдаж, шинэ нь
  олгогддог. Хуучин (аль хэдийн ашигласан) token-оор дахин оролдвол шууд
  татгалзана — энэ нь токен хулгайлагдсан эсэхийг илрүүлэх механизм.
- **Generic error message**: "имэйл олдсонгүй" ба "нууц үг буруу" хоёрыг ялгаж
  харуулахгүй — user enumeration халдлагаас сэргийлнэ.
- **2 давхаргат brute-force хамгаалалт**: IP-based rate limit (route дээр) +
  account-based lockout (тухайн хэрэглэгчийн `failed_login_attempts`) — аль
  нэгийг нь тойрч гарсан ч нөгөө нь барина.
- **Audit log**: `REVOKE UPDATE, DELETE` заавлыг production deploy хийхдээ
  заавал ажиллуулах ёстой (`001_init_auth.sql` файлын төгсгөлд тайлбарласан) —
  ингэснээр application code compromise болсон ч audit trail устгагдахгүй.

## Дараагийн алхмууд (энэ scope-д ороогүй)

- Azure Key Vault + Managed Identity холболт (одоогоор `.env`-с шууд унших)
- RLS session variable middleware (company/department table үүсэхэд нэмэгдэнэ)
- `companies`/`departments` CRUD, `department_templates` (form_schema)
- Form submission + maker-checker workflow
- Azure Blob SAS token endpoint-ууд
