# Siatkarski Ranking

Strona dla zamkniętej ekipy: ranking roczny, sesje, pojedynki 1v1, głosowanie na MVP.
Ciemny motyw, mobile first. Logowanie wyłącznie przez Google.

**Stos:** statyczna strona (HTML/CSS/JS, bez kroku budowania) + [Supabase](https://supabase.com)
(Postgres, logowanie Google). Wszystkie reguły — okna czasowe, limit 1 pkt na sesję, kto może głosować —
pilnuje baza, nie przeglądarka. Punkty nie są nigdzie zapisywane jako sumy: liczy je widok
`v_session_points` z zapisanych wyników i głosów, więc zmiana lub cofnięcie głosu od razu zmienia ranking.

## Pliki

| Plik | Co to |
|---|---|
| `supabase/schema.sql` | Cała baza: tabele, reguły (funkcje RPC), liczenie punktów, uprawnienia |
| `index.html`, `app.js`, `styles.css` | Aplikacja |
| `config.js` | Adres i klucz Supabase — **do uzupełnienia** |
| `demo.html`, `tools/mock.js` | Podgląd UI na danych testowych, bez backendu (nie wrzucaj na serwer) |
| `tools/serve.ps1` | Lokalny serwer do podglądu: `powershell -File tools/serve.ps1` → http://localhost:5500/demo.html |

## Uruchomienie (ok. 20 minut)

### 1. Supabase
1. Załóż darmowe konto i projekt na supabase.com (region: Frankfurt / `eu-central-1`).
2. **SQL Editor → New query**, wklej całe `supabase/schema.sql`, **Run**.
3. W tym samym edytorze dodaj siebie jako administratora (wpisz swój Gmail):
   ```sql
   insert into allowed_emails (email, is_admin) values ('twoj.adres@gmail.com', true);
   ```
4. **Project Settings → API**: skopiuj *Project URL* i klucz *anon public* do `config.js`.

### 2. Logowanie Google
1. [Google Cloud Console](https://console.cloud.google.com) → nowy projekt → **APIs & Services → OAuth consent screen**:
   typ *External*, nazwa aplikacji, Twój e-mail. Zakresy domyślne (email, profile) wystarczą.
2. **Credentials → Create credentials → OAuth client ID** → *Web application*.
   W **Authorized redirect URIs** wpisz: `https://<twoj-projekt>.supabase.co/auth/v1/callback`
3. Skopiuj *Client ID* i *Client secret* do Supabase: **Authentication → Sign In / Providers → Google** → włącz.
4. W Supabase **Authentication → URL Configuration**: *Site URL* = adres strony (np. `https://ranking-siatka.netlify.app`),
   a w *Redirect URLs* dodaj ten sam adres.

### 3. Hosting
Najprościej: [Netlify Drop](https://app.netlify.com/drop) — przeciągnij folder z plikami
`index.html`, `app.js`, `styles.css`, `config.js`, `icon.svg`, `manifest.webmanifest`.
Działa też GitHub Pages, Vercel, Cloudflare Pages — to zwykłe pliki statyczne.
Po zmianie adresu strony popraw *Site URL* z kroku 2.4.

### 4. Ekipa
Zaloguj się → **Więcej → Administracja**. Dodaj Gmaile ekipy. Kto zaloguje się, nie będąc na liście,
zobaczy „Brak dostępu” i pojawi się u admina w sekcji *Zalogowani bez dostępu* (przycisk *Wpuść*).

Na telefonie: „Dodaj do ekranu głównego” — strona działa jak aplikacja.

## Jak reguły ze specyfikacji są zaimplementowane

- **Typy sesji** — `ekipowa`: wygrana + MVP + pojedynki; `mieszana`: MVP + pojedynki; `randomy`: domyślnie nic
  (lider może włączyć MVP/pojedynki przy tworzeniu sesji; domyślne ustawienie zmienia admin).
- **Limit 1 pkt na osobę na sesję** — widok grupuje wszystkie powody i daje 1 punkt; powody widać przy sesji.
  Wyjątek: **sesja mieszana** — MVP i wygrany pojedynek to osobne punkty (max 2); premia za powrót /
  nieparzystość dają punkt tylko wtedy, gdy nie ma żadnego z nich (migracja `002`).
- **Limit wyzwań** — jedno wysłane wyzwanie na osobę na sesję (kolejne dopiero po odrzuceniu / anulowaniu),
  i jeden zaakceptowany pojedynek na osobę na sesję.
- **Zdjęcie profilowe** — Więcej → dotknij zdjęcia: własny plik (przycinany do 320×320, Supabase Storage,
  bucket `avatars`) albo powrót do zdjęcia z Google.
- **Remis / brak głosów** — brak punktu (MVP i pojedynki).
- **Pojedynki** — wyzwanie i akceptacja do połowy sesji; po niej oczekujące wygasają. Wycofanie zaakceptowanego
  do końca sesji. Głosują obecni na sesji poza dwójką z pojedynku, przez 24 h od końca. Jedna osoba = jeden
  zaakceptowany pojedynek na sesję. Wyzwanie / akceptacja automatycznie dopisuje do składu.
- **MVP** — głosują obecni (nie na siebie), 24 h od końca sesji. Głos można zmienić lub cofnąć.
- **Premia za powrót** — pierwsza obecność po ≥ 4 kolejnych sesjach bez gry (liczone w sesjach, które już się
  zaczęły). Licznik resetuje się sam przy każdej obecności.
- **Nieparzystość** — tylko sesje z pojedynkami, nie ekipowe. Lider przyznaje +1 osobie bez pary, która nie ma
  „nie chcę wyzywać”, z obowiązkowym powodem (trafia do historii).
- **Wpis wyników** — lider albo każdy za siebie przez `entry_window_hours` (24 h, admin może przełączyć na 48 h)
  od startu. Jeśli lider nie kliknie „Zatwierdź wyniki” w tym czasie, każdy może wpisać swoje do startu
  następnej sesji. Potem blokada; zmienia tylko admin, z powodem zapisywanym w historii.
- **Historia** — każda zmiana (wynik, głos, wyzwanie, korekta, ustawienia) trafia do tabeli `history`.
- **Ranking roczny** — liczony wg roku startu sesji (czas polski). Rok 2026 jest oznaczony jako testowy;
  od 1 stycznia 2027 ranking startuje od zera (data w `app_config.launch_date`).

### Założenia, które przyjąłem (do potwierdzenia z ekipą)
- **Premia za powrót** nie należy się nowej osobie przy jej pierwszej sesji w ogóle — dopiero po wcześniejszej obecności.
- **MVP**: nie można głosować na siebie.
- Sesję może utworzyć każdy z ekipy; liderem zostaje twórca (albo wybrana osoba).
- Admin może poprawić wynik lub sesję w dowolnym momencie, ale zawsze z powodem. Głosów admin nie zmienia.
- Wygaśnięcie wyzwań i okna głosowania wynikają z godzin sesji — nic nie musi działać w tle.
