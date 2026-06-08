const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/rd/leads', async (req, res) => {
  const key = req.headers['x-rd-mkt-key'];
  if (!key) return res.status(400).json({ error: 'API key não informada' });
  try {
    const r = await fetch('https://api.rd.services/platform/contacts?page_size=200&order=created_at&sort=desc', {
      headers: { 'Authorization': 'Bearer ' + key }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Erro RD Marketing' });
    const data = await r.json();
    const contacts = data.contacts || [];
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const leadsDoMes = contacts.filter(c => new Date(c.created_at) >= inicioMes);
    res.json({ total_mes: leadsDoMes.length, total_geral: data.total || contacts.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rd/oportunidades', async (req, res) => {
  const key = req.headers['x-rd-crm-key'];
  if (!key) return res.status(400).json({ error: 'API key não informada' });
  try {
    const r = await fetch('https://crm.rdstation.com/api/v1/deals?page=1&limit=200', {
      headers: { 'token': key }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Erro RD CRM' });
    const data = await r.json();
    const deals = data.deals || [];
    res.json({ abertas: deals.filter(d => !d.win && !d.lost).length, ganhas: deals.filter(d => d.win).length, total: deals.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rd/fechados', async (req, res) => {
  const key = req.headers['x-rd-crm-key'];
  const period = req.query.period || 'semana';
  if (!key) return res.status(400).json({ error: 'API key não informada' });
  try {
    const hoje = new Date(); hoje.setHours(23,59,59,999);
    const inicio = new Date();
    if (period === 'semana') { inicio.setDate(hoje.getDate() - 6); } else { inicio.setDate(1); }
    inicio.setHours(0,0,0,0);
    let page = 1, allDeals = [];
    while (true) {
      const r = await fetch(`https://crm.rdstation.com/api/v1/deals?page=${page}&limit=200&win=true`, { headers: { 'token': key } });
      if (!r.ok) break;
      const data = await r.json();
      const deals = data.deals || [];
      if (!deals.length) break;
      allDeals = allDeals.concat(deals);
      if (deals.length < 200) break;
      page++; if (page > 10) break;
    }
    const filtrados = allDeals.filter(d => {
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
    res.json({ total_pedidos: filtrados.length, valor_total: filtrados.reduce((acc,d) => acc + parseFloat(d.amount_montly || d.amount || 0), 0), periodo: period, ranking });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ping', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hakuna Campanhas rodando na porta ${PORT}`));
