package com.decodeurfinancier.gestion;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.util.Base64;
import android.print.PrintManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Le Décodeur Financier — Gestion, application Android.
 *
 * L'application web (dossier assets/www) est servie depuis l'appareil à l'adresse
 * https://appassets.androidplatform.net/ : elle démarre sans réseau et garde ses données
 * (session, catalogue, ventes en attente) dans la vue web. Les appels à la base partent
 * directement vers le projet Supabase configuré au premier lancement.
 *
 * Pont « DFGAndroid » exposé à la page : impression par le service d'impression
 * d'Android et enregistrement de fichiers (exports) dans « Téléchargements ».
 */
public class MainActivity extends Activity {
    private static final String HOTE = "appassets.androidplatform.net";
    private static final String ORIGINE = "https://" + HOTE + "/";
    private static final int CODE_FICHIERS = 1;
    private static final int CODE_CAMERA = 2;
    private static final int CODE_STOCKAGE = 3;

    private WebView web;
    private ValueCallback<Uri[]> rappelFichiers;
    private PermissionRequest demandeCamera;

    @Override
    protected void onCreate(Bundle etat) {
        super.onCreate(etat);
        getWindow().setStatusBarColor(0xFF141414);

        web = new WebView(this);
        setContentView(web);

        WebSettings r = web.getSettings();
        r.setJavaScriptEnabled(true);
        r.setDomStorageEnabled(true);
        r.setDatabaseEnabled(true);
        r.setMediaPlaybackRequiresUserGesture(false);
        r.setAllowFileAccess(false);
        // Tailles identiques sur tous les téléphones : la taille de police du système n'agrandit plus l'application.
        r.setTextZoom(100);
        r.setUserAgentString(r.getUserAgentString() + " DFGestionAndroid/" + BuildConfig.VERSION);

        web.addJavascriptInterface(new Pont(), "DFGAndroid");
        web.setWebViewClient(new ClientWeb());
        web.setWebChromeClient(new ClientChrome());

        if (etat != null) web.restoreState(etat);
        else web.loadUrl(ORIGINE);
    }

    @Override
    protected void onSaveInstanceState(Bundle etat) {
        super.onSaveInstanceState(etat);
        web.saveState(etat);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ------------------------------------------------------------------
    // Fichiers de l'application servis depuis l'appareil
    // ------------------------------------------------------------------

    private class ClientWeb extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView vue, WebResourceRequest requete) {
            Uri u = requete.getUrl();
            if (!HOTE.equals(u.getHost())) return null; // Supabase et le reste : réseau normal
            return servir(u.getPath());
        }

        // Variante « String » : appelée sur toutes les versions d'Android (la variante
        // WebResourceRequest, apparue en API 24, la rappelle par défaut).
        @Override
        public boolean shouldOverrideUrlLoading(WebView vue, String adresse) {
            Uri u = Uri.parse(adresse);
            if (HOTE.equals(u.getHost())) return false;
            // Liens externes (WhatsApp, site web…) : application ou navigateur du téléphone.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, "Aucune application pour ouvrir ce lien", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
    }

    private WebResourceResponse servir(String chemin) {
        String c = (chemin == null || chemin.equals("/") || chemin.isEmpty()) ? "index.html" : chemin.substring(1);
        if (c.contains("..")) return reponse404();
        InputStream flux = ouvrir(c);
        if (flux == null) {
            // Adresse de l'application (ex. /caisse) : c'est index.html qui l'affiche.
            String dernier = c.substring(c.lastIndexOf('/') + 1);
            if (dernier.contains(".")) return reponse404();
            c = "index.html";
            flux = ouvrir(c);
            if (flux == null) return reponse404();
        }
        Map<String, String> entetes = new HashMap<String, String>();
        entetes.put("Cache-Control", "no-cache");
        entetes.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse(typeDe(c), "UTF-8", 200, "OK", entetes, flux);
    }

    private InputStream ouvrir(String chemin) {
        try {
            return getAssets().open("www/" + chemin);
        } catch (IOException e) {
            return null;
        }
    }

    private WebResourceResponse reponse404() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String typeDe(String chemin) {
        String c = chemin.toLowerCase(Locale.ROOT);
        if (c.endsWith(".html")) return "text/html";
        if (c.endsWith(".js") || c.endsWith(".mjs")) return "text/javascript";
        if (c.endsWith(".css")) return "text/css";
        if (c.endsWith(".svg")) return "image/svg+xml";
        if (c.endsWith(".png")) return "image/png";
        if (c.endsWith(".jpg") || c.endsWith(".jpeg")) return "image/jpeg";
        if (c.endsWith(".webp")) return "image/webp";
        if (c.endsWith(".json") || c.endsWith(".webmanifest")) return "application/json";
        if (c.endsWith(".woff2")) return "font/woff2";
        if (c.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------
    // Caméra (scan) et choix de fichiers (logo, photos)
    // ------------------------------------------------------------------

    private class ClientChrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest demande) {
            boolean video = false;
            for (String res : demande.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) video = true;
            }
            if (!video) {
                demande.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                demande.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            } else {
                demandeCamera = demande;
                requestPermissions(new String[] { Manifest.permission.CAMERA }, CODE_CAMERA);
            }
        }

        @Override
        public boolean onShowFileChooser(WebView vue, ValueCallback<Uri[]> rappel, FileChooserParams parametres) {
            if (rappelFichiers != null) rappelFichiers.onReceiveValue(null);
            rappelFichiers = rappel;
            try {
                Intent choix = parametres.createIntent();
                // Plusieurs fichiers d'un coup (photos du catalogue) : Android ne l'active pas tout seul.
                if (parametres.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    choix.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                // Tableurs : certains gestionnaires de fichiers ne connaissent pas le type .xlsx.
                String[] types = parametres.getAcceptTypes();
                if (types != null && types.length > 1) {
                    choix.setType("*/*");
                    java.util.ArrayList<String> mimes = new java.util.ArrayList<>();
                    for (String t : types) if (t != null && t.contains("/")) mimes.add(t);
                    if (!mimes.isEmpty()) choix.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                }
                startActivityForResult(choix, CODE_FICHIERS);
            } catch (ActivityNotFoundException e) {
                rappelFichiers = null;
                rappel.onReceiveValue(null);
                return false;
            }
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] resultats) {
        super.onRequestPermissionsResult(code, permissions, resultats);
        if (code == CODE_CAMERA && demandeCamera != null) {
            if (resultats.length > 0 && resultats[0] == PackageManager.PERMISSION_GRANTED) {
                demandeCamera.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            } else {
                demandeCamera.deny();
            }
            demandeCamera = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int resultat, Intent donnees) {
        super.onActivityResult(code, resultat, donnees);
        if (code == CODE_FICHIERS && rappelFichiers != null) {
            Uri[] choisis = null;
            if (resultat == RESULT_OK && donnees != null && donnees.getClipData() != null) {
                android.content.ClipData clip = donnees.getClipData();
                choisis = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) choisis[i] = clip.getItemAt(i).getUri();
            } else {
                choisis = WebChromeClient.FileChooserParams.parseResult(resultat, donnees);
            }
            rappelFichiers.onReceiveValue(choisis);
            rappelFichiers = null;
        }
    }

    // ------------------------------------------------------------------
    // Pont JavaScript « DFGAndroid »
    // ------------------------------------------------------------------

    private class Pont {
        /** Imprime la page telle que définie pour l'impression (ticket, rapport, étiquettes). */
        @JavascriptInterface
        public void imprimer(final String titre) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    PrintManager impression = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                    String nom = (titre == null || titre.trim().isEmpty()) ? "Ticket" : titre.trim();
                    impression.print(nom, web.createPrintDocumentAdapter(nom), new PrintAttributes.Builder().build());
                }
            });
        }

        /** Enregistre un fichier texte (export CSV) dans « Téléchargements ». Renvoie "" ou un message d'erreur. */
        @JavascriptInterface
        public String enregistrer(final String nom, String type, String contenu) {
            try {
                return ecrire(nom, type, contenu.getBytes("UTF-8"));
            } catch (Exception e) {
                return "Enregistrement impossible : " + e.getMessage();
            }
        }

        /** Enregistre un fichier binaire (Excel .xlsx, PDF) transmis en base64. */
        @JavascriptInterface
        public String enregistrerBase64(final String nom, String type, String base64) {
            try {
                return ecrire(nom, type, Base64.decode(base64, Base64.DEFAULT));
            } catch (Exception e) {
                return "Enregistrement impossible : " + e.getMessage();
            }
        }

        private String ecrire(final String nom, String type, byte[] octets) throws IOException {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues valeurs = new ContentValues();
                    valeurs.put("_display_name", nom);
                    valeurs.put("mime_type", type);
                    valeurs.put("relative_path", "Download/");
                    Uri uri = getContentResolver().insert(Uri.parse("content://media/external/downloads"), valeurs);
                    if (uri == null) return "Enregistrement impossible dans Téléchargements";
                    OutputStream sortie = getContentResolver().openOutputStream(uri);
                    sortie.write(octets);
                    sortie.close();
                } else {
                    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, CODE_STOCKAGE);
                        return "Autorisez l'accès au stockage, puis relancez l'export.";
                    }
                    File dossier = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    dossier.mkdirs();
                    FileOutputStream sortie = new FileOutputStream(new File(dossier, nom));
                    sortie.write(octets);
                    sortie.close();
                }
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "Enregistré dans Téléchargements : " + nom, Toast.LENGTH_LONG).show();
                    }
                });
                return "";
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION;
        }
    }
}
