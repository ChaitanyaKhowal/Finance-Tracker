# Finance Tracker

A focused, responsive personal finance web application built with React, Vite, and Supabase. It provides real-time income and expense tracking, batch transaction entry, CSV statement imports, and period-based spending analytics with secure user-isolated cloud storage.

![Finance Tracker Screenshot](./src/assets/hero.png)

---

## Features

| Feature | Description |
|---|---|
| **Cloud Authentication** | Supabase Auth with Row-Level Security (RLS) policies ensuring complete data isolation between user accounts. |
| **Transaction Entry** | Single-entry form and rapid multi-item batch entry. Each batch row supports its own date, amount, category, type, and optional notes. |
| **Financial KPIs** | Live balance, monthly income, monthly expenses, and net savings rate with period-over-period percentage comparisons. |
| **Period Filtering** | Filter dashboard and transactions by Current Month, Last Month, Year-to-Date, All Time, or a custom date range. |
| **Transaction Table** | Search by description/notes, filter by category and transaction type, column sorting, pagination (10–100 rows/page), and multi-select bulk deletion. |
| **CSV Statement Import** | Chunked CSV ingestion (50 records per batch) with duplicate prevention, detailed row-level error reporting, and non-destructive partial upload recovery. |
| **Sample Data Safeguards** | Verified sample record detection using deterministic IDs to prevent accidental deletion of legitimate user entries. |
| **Theme System** | Built-in Light and Dark themes styled with a refined forest-green and warm neutral palette. |

---

## Tech Stack

- **Frontend:** React 19, Vite 8
- **Icons:** Lucide React
- **Backend & Auth:** Supabase (`@supabase/supabase-js` v2)
- **Styling:** Custom CSS design system with CSS custom properties (variables)
- **Testing:** Node.js built-in test runner (`node --test`)

---

## Getting Started

### Prerequisites

- Node.js 20 or higher
- npm 10 or higher
- A Supabase project with database tables and authentication configured

### Local Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/ChaitanyaKhowal/Finance-Tracker.git
   cd Finance-Tracker
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Create a `.env` file in the project root:
   ```env
   VITE_SUPABASE_URL=https://your-project-id.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```
   > Both variables are required. If either variable is missing, the application renders an on-screen setup guide instead of crashing.

4. **Start the development server:**
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` in your browser.

5. **Build for production:**
   ```bash
   npm run build
   ```

6. **Run tests:**
   ```bash
   npm test
   ```

---

## Database Schema (Supabase)

The application expects a `transactions` table in your Supabase schema with Row-Level Security (RLS) enabled:

```sql
create table public.transactions (
  id text primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  date date not null,
  amount numeric(12, 2) not null,
  type text check (type in ('income', 'expense')) not null,
  category text not null,
  description text not null,
  payment_mode text default 'UPI',
  notes text,
  created_at timestamptz default now()
);

-- Enable Row Level Security
alter table public.transactions enable row level security;

-- Policies
create policy "Users can view their own transactions"
  on public.transactions for select
  using (auth.uid() = user_id);

create policy "Users can insert their own transactions"
  on public.transactions for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own transactions"
  on public.transactions for update
  using (auth.uid() = user_id);

create policy "Users can delete their own transactions"
  on public.transactions for delete
  using (auth.uid() = user_id);
```

---

## Deploying to Netlify

This repository includes a preconfigured `netlify.toml` and `public/_redirects` for Single Page Application (SPA) routing.

### Step-by-Step Deployment

1. **Push your code to GitHub.**
2. Log in to [Netlify](https://app.netlify.com) and click **Add new site > Import an existing project**.
3. Select your repository (`finance-tracker`).
4. Netlify will automatically detect settings from `netlify.toml`:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
5. **Add Environment Variables in Netlify:**
   - Go to **Site configuration > Environment variables**.
   - Add `VITE_SUPABASE_URL` with your Supabase project URL.
   - Add `VITE_SUPABASE_ANON_KEY` with your Supabase anon/public key.
6. Click **Deploy site**.
7. If your site was deployed before adding environment variables, go to **Deploys > Trigger deploy > Clear cache and deploy site**.

---

## Security Notes

- **Never commit `.env` or credentials:** `.env` is listed in `.gitignore`. Keep your Supabase credentials secure. Never use the Supabase `service_role` key in client-side code; only use the public `anon` key.
- **Row-Level Security (RLS):** Ensure RLS is enabled on all tables in Supabase so that users can only query, modify, or delete their own data.
- **Personal Financial Data:** Never commit transaction exports, personal CSV files, or database backups to git.

---

## Known Limitations

- **Dev Dependency Audit:** `npm audit` reports 6 vulnerabilities (1 moderate, 5 high) in build-time dev dependencies (`brace-expansion`, `browserslist`, `nanoid`, `postcss`, `source-map-js`). These are transitive dependencies of the Vite build pipeline and do not affect client-side bundle execution. Upstream updates will be applied as patched patch versions are released.
- **Client-Side CSV Parsing:** Statement imports run entirely in the browser using client-side parsing before chunked Supabase upserts. Large files (>5,000 rows) should be split into smaller files for optimal memory handling.
