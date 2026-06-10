const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PIN = process.env.ACCESS_PIN || '1234';
const RD_MKT_KEY = process.env.RD_MKT_KEY || '';
const RD_CRM_KEY = process.env.RD_CRM_KEY || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campanhas (
      id BIGINT PRIMARY KEY,
      titulo TEXT, setor TEXT, inicio TEXT, fim TEXT,
      premio TEXT, criterio TEXT, desempate TEXT,
      regras TEXT, abrangencia TEXT, criada TEXT
    )
  `);
  console.log('Banco de dados pronto!');
}

function checkPin(req, res, next) {
  const pin = req.headers['x-access-pin'];
  if (pin !== PIN) return res.status(401).json({ error: 'PIN inválido' });
  next();
}

app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  if (pin === PIN) res.json({ ok: true });
  else res.status(401).json({ error: 'PIN incorreto' });
});

app.get('/api/campanhas', checkPin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM campanhas ORDER BY id ASC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/campanhas', checkPin, async (req, res) => {
  try {
    const { titulo, setor, inicio, fim, premio, criterio, desempate, regras, abrangencia } = req.body;
    const id = Date.now();
    const criada = new Date().toISOString();
    await pool.query(
      `INSERT INTO campanhas (id,titulo,setor,inicio,fim,premio,criterio,desempate,regras,abrangencia,criada) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, titulo, setor, inicio, fim, premio, criterio, desempate, regras||'', abrangencia, criada]
    );
    res.json({ id, titulo, setor, inicio, fim, premio, criterio, desempate, regras, abrangencia, criada });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/campanhas/:id', checkPin, async (req, res) => {
  try {
    await pool.query('DELETE FROM campanhas WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// RD Marketing — usa Bearer token no header
app.get('/api/rd/leads', checkPin, async (req, res) => {
  if (!RD_MKT_KEY) return res.status(400).json({ error: 'RD_MKT_KEY não configurada' });
  try {
    const r = await fetch('https://api.rd.services/platform/contacts?page_size=200&order=created_at&sort=desc', {
      headers: { 'Authorization': 'Bearer ' + RD_MKT_KEY }
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: 'Erro RD Marketing', detail: err });
    }
    const data = await r.json();
    const contacts = data.contacts || [];
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    res.json({ total_mes: contacts.filter(c => new Date(c.created_at) >= inicioMes).length, total_geral: data.total || contacts.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// RD CRM — usa token na URL (formato correto)
app.get('/api/rd/oportunidades', checkPin, async (req, res) => {
  if (!RD_CRM_KEY) return res.status(400).json({ error: 'RD_CRM_KEY não configurada' });
  try {
    const r = await fetch(`https://crm.rdstation.com/api/v1/deals?token=${RD_CRM_KEY}&page=1&limit=200`);
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: 'Erro RD CRM', detail: err });
    }
    const data = await r.json();
    const deals = data.deals || [];
    res.json({ abertas: deals.filter(d => !d.win && !d.lost).length, ganhas: deals.filter(d => d.win).length, total: deals.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// RD CRM Fechados + Ranking
app.get('/api/rd/fechados', checkPin, async (req, res) => {
  if (!RD_CRM_KEY) return res.status(400).json({ error: 'RD_CRM_KEY não configurada' });
  const period = req.query.period || 'semana';
  try {
    const hoje = new Date(); hoje.setHours(23,59,59,999);
    const inicio = new Date();
    if (period === 'semana') { inicio.setDate(hoje.getDate() - 6); } else { inicio.setDate(1); }
    inicio.setHours(0,0,0,0);

    let page = 1, allDeals = [];
    while (true) {
      const r = await fetch(`https://crm.rdstation.com/api/v1/deals?token=${RD_CRM_KEY}&page=${page}&limit=200`);
      if (!r.ok) break;
      const data = await r.json();
      const deals = data.deals || [];
      if (!deals.length) break;
      allDeals = allDeals.concat(deals);
      if (deals.length < 200) break;
      page++; if (page > 20) break;
    }

    // Filtra vendidos — win=true OU etapa com "vend"
    const vendidos = allDeals.filter(d => d.win === true || (d.deal_stage?.name || '').toLowerCase().includes('vend'));

    // Filtra pelo período
    const filtrados = vendidos.filter(d => {
      const dt = d.closed_at ? new Date(d.closed_at) : new Date(d.updated_at);
      return dt >= inicio && dt <= hoje;
    });

    const porVendedor = {};
    filtrados.forEach(deal => {
      const nome = deal.user?.name || 'Sem responsável';
      const equipe = deal.campaign?.name || deal.deal_source?.name || '—';
      if (!porVendedor[nome]) porVendedor[nome] = { nome, equipe, pedidos: 0, valor: 0 };
      porVendedor[nome].pedidos++;
      porVendedor[nome].valor += parseFloat(deal.amount_montly || deal.amount || 0);
    });

    const ranking = Object.values(porVendedor).sort((a,b) => b.pedidos - a.pedidos || b.valor - a.valor);
    res.json({
      total_pedidos: filtrados.length,
      valor_total: filtrados.reduce((acc,d) => acc + parseFloat(d.amount_montly || d.amount || 0), 0),
      periodo: period,
      ranking
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug — remover depois
app.get('/api/debug/deal', async (req, res) => {
  try {
    const r = await fetch(`https://crm.rdstation.com/api/v1/deals?token=${RD_CRM_KEY}&page=1&limit=1`);
    const text = await r.text();
    res.json({ status: r.status, key_present: !!RD_CRM_KEY, key_length: RD_CRM_KEY.length, body: text.substring(0, 500) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ping', (_, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Hakuna Campanhas rodando na porta ${PORT}`));
}).catch(e => {
  console.error('Erro ao conectar banco:', e.message);
  process.exit(1);
});
