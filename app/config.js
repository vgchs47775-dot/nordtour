// Verbindung zu Supabase. Beide Werte sind öffentlich gedacht (stehen in jeder Supabase-Web-App):
// Geschützt werden die Daten durch Login + Row Level Security (siehe supabase/setup.sql).
// Leer lassen = App speichert nur im Browser.
window.NORDTOUR_CONFIG = {
  supabaseUrl: "https://hhzbxveismirmxkbuaom.supabase.co",
  supabaseKey: "sb_publishable__0O5nnBXSGZ4-xy-03wmqw_A4jEKPgn"   // Publishable key (öffentlich gedacht)
};
