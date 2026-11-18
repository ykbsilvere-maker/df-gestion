package com.decodeurfinancier.gestion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Vérification des commandes en ligne quand l'application est fermée (toutes les 15 minutes environ,
 * le minimum permis par Android). Le téléphone n'envoie qu'un jeton d'appareil : le serveur répond
 * seulement par des nombres (commandes affectées, à affecter, en attente). Aucune donnée client ici.
 */
public class VeilleCommandes extends JobService {
    static final int TACHE = 4207;
    static final int NOTIFICATION = 7;
    static final String CANAL = "commandes_en_ligne";
    private static final String PREFS = "veille_commandes";

    /** Appelée par la page (pont JavaScript) : mémorise le serveur et programme la vérification. */
    static void programmer(Context ctx, String url, String cle, String jeton) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean change = !jeton.equals(p.getString("jeton", ""));
        p.edit().putString("url", url).putString("cle", cle).putString("jeton", jeton).apply();
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        if (!change) {
            for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == TACHE) return;
        }
        JobInfo.Builder b = new JobInfo.Builder(TACHE, new ComponentName(ctx, VeilleCommandes.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true);
        js.schedule(b.build());
    }

    /** Déconnexion : plus de vérification, plus de jeton. */
    static void arreter(Context ctx) {
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js != null) js.cancel(TACHE);
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
        NotificationManager g = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (g != null) g.cancel(NOTIFICATION);
    }

    /** Notification « Commandes en ligne » : visible sur l'écran verrouillé, avec son et vibration. */
    static void afficher(Context ctx, String titre, String texte, int nombre) {
        NotificationManager g = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (g == null) return;
        if (nombre <= 0) {
            g.cancel(NOTIFICATION);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
                && ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return;
        Notification.Builder n;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel canal = new NotificationChannel(CANAL, "Commandes en ligne", NotificationManager.IMPORTANCE_HIGH);
            canal.setDescription("Nouvelle commande DF Marché à traiter");
            canal.enableVibration(true);
            canal.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            g.createNotificationChannel(canal);
            n = new Notification.Builder(ctx, CANAL);
        } else {
            n = new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        }
        Intent ouvrir = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        int drapeaux = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        n.setSmallIcon(ctx.getApplicationInfo().icon)
                .setContentTitle(titre)
                .setContentText(texte)
                .setStyle(new Notification.BigTextStyle().bigText(texte))
                .setNumber(nombre)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setContentIntent(PendingIntent.getActivity(ctx, 0, ouvrir, drapeaux));
        g.notify(NOTIFICATION, n.build());
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    verifier();
                } catch (Exception e) {
                    // Pas de réseau ou serveur indisponible : on réessaiera au prochain passage.
                }
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    private void verifier() throws Exception {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = p.getString("url", "");
        String cle = p.getString("cle", "");
        String jeton = p.getString("jeton", "");
        if (url.isEmpty() || cle.isEmpty() || jeton.isEmpty()) return;

        HttpURLConnection c = (HttpURLConnection) new URL(url + "/rest/v1/rpc/appareil_attente").openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(12000);
        c.setReadTimeout(12000);
        c.setDoOutput(true);
        c.setRequestProperty("apikey", cle);
        c.setRequestProperty("Authorization", "Bearer " + cle);
        c.setRequestProperty("Content-Type", "application/json");
        OutputStream sortie = c.getOutputStream();
        sortie.write(new JSONObject().put("p_jeton", jeton).toString().getBytes("UTF-8"));
        sortie.close();
        if (c.getResponseCode() != 200) return;
        InputStream entree = c.getInputStream();
        ByteArrayOutputStream tampon = new ByteArrayOutputStream();
        byte[] b = new byte[4096];
        int lu;
        while ((lu = entree.read(b)) > 0) tampon.write(b, 0, lu);
        entree.close();
        String corps = tampon.toString("UTF-8").trim();
        if (corps.isEmpty() || corps.equals("null")) {
            // Jeton inconnu (déconnecté sur ce téléphone) : on arrête.
            arreter(this);
            return;
        }
        JSONObject o = new JSONObject(corps);
        boolean gerante = o.optBoolean("gerante", false);
        int nombre = o.optInt("nombre", 0);
        boolean affecteur = gerante || o.optBoolean("affecteur", false);
        int aAffecter = affecteur ? o.optInt("a_affecter", 0) : 0;
        int enAttente = affecteur ? 0 : o.optInt("en_attente", 0);
        int aAccepter = o.optInt("a_accepter", 0);
        int aLivrer = gerante ? o.optInt("a_livrer", 0) : 0;
        int avantN = p.getInt("nombre", 0), avantA = p.getInt("a_affecter", 0), avantE = p.getInt("en_attente", 0);
        int avantL = p.getInt("a_livrer", 0);
        p.edit().putInt("nombre", nombre).putInt("a_affecter", aAffecter).putInt("en_attente", enAttente)
                .putInt("a_livrer", aLivrer).apply();
        int total = nombre + aAffecter + enAttente + aLivrer;
        if (aAccepter > 0) {
            // Pas encore acceptée : on rappelle à chaque vérification, jusqu'à ce que la caissière accepte.
            afficher(this, "Commande affectée à vous", aAccepter + " commande(s) à accepter : ouvrez DF Gestion et touchez « Accepter ».", total);
        } else if (nombre > avantN) {
            afficher(this, "Commande affectée à vous", nombre + " commande(s) à rassembler et vérifier.", total);
        } else if (aLivrer > avantL) {
            afficher(this, "Commande prête à livrer", aLivrer + " commande(s) prête(s) : confirmez la livraison.", total);
        } else if (aAffecter > avantA) {
            afficher(this, "Nouvelle commande en ligne", aAffecter + " commande(s) à affecter à une caissière.", total);
        } else if (enAttente > avantE) {
            afficher(this, "Nouvelle commande en ligne", enAttente + " commande(s) en attente d'affectation par la gérante.", total);
        } else if (total == 0) {
            afficher(this, "", "", 0);
        }
    }
}
