// ══════════════════════════════════════════════════════════════
//  OIBASE — Stripe webhook
//  Stripe roept dit aan na een betaling / wijziging. We zetten dan
//  het abonnement van het bedrijf op 'actief' of 'geblokkeerd' in
//  Supabase (met de service-role sleutel, die RLS omzeilt).
// ══════════════════════════════════════════════════════════════
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe controleert de handtekening op de RUWE body — dus body-parsing uit.
export const config = { api: { bodyParser: false } };

async function ruweBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  let event;
  try {
    const buf = await ruweBody(req);
    event = stripe.webhooks.constructEvent(
      buf, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error('Webhook-handtekening fout:', e.message);
    res.status(400).send('Webhook Error: ' + e.message);
    return;
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.client_reference_id) {
        await sb.from('bedrijven').update({
          abonnement_status: 'actief',
          stripe_customer_id: s.customer,
          stripe_subscription_id: s.subscription,
        }).eq('id', s.client_reference_id);
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const actief = (sub.status === 'active' || sub.status === 'trialing');
      await sb.from('bedrijven')
        .update({ abonnement_status: actief ? 'actief' : 'geblokkeerd' })
        .eq('stripe_subscription_id', sub.id);
    } else if (event.type === 'customer.subscription.deleted') {
      await sb.from('bedrijven')
        .update({ abonnement_status: 'geblokkeerd' })
        .eq('stripe_subscription_id', event.data.object.id);
    } else if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      if (inv.subscription) {
        await sb.from('bedrijven')
          .update({ abonnement_status: 'geblokkeerd' })
          .eq('stripe_subscription_id', inv.subscription);
      }
    }
  } catch (e) {
    console.error('Webhook-verwerking fout:', e);
  }

  res.status(200).json({ received: true });
}
