using System.Text;

namespace Runova.ServerCore.Docker;

/// <summary>
/// The files the pretend containers and volumes start with: a small Debian-like root in each
/// container (none in the distroless one, which has only its binary and certificates), what its
/// image would add, and the volumes it mounts as the shared folder nodes they are.
/// </summary>
internal sealed partial class InMemoryDockerEngine
{
    private const int Node = 1000;
    private const int Postgres = 999;
    private const int Nobody = 65534;

    private MemoryDirectory ContainerRoot(Container container)
    {
        var at = NowMs - (long)TimeSpan.FromDays(3).TotalMilliseconds;
        var root = new MemoryDirectory { Permissions = 0x1ED, MtimeMs = at };
        var tree = new TreeWriter(root, at);
        if (container.Kind == Kind.Tunnel)
        {
            tree.File("/usr/local/bin/cloudflared", new byte[48 * 1024], 0x1ED);
            tree.File("/etc/ssl/certs/ca-certificates.crt", "-----BEGIN CERTIFICATE-----\nMIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw\n-----END CERTIFICATE-----\n");
            tree.File("/etc/passwd", "root:x:0:0:root:/root:/sbin/nologin\nnonroot:x:65532:65532:nonroot:/home/nonroot:/sbin/nologin\n");
            tree.File("/etc/cloudflared/config.yml", "tunnel: 6ff42ae2-765d-4adf-8112-31c55c1551ef\ncredentials-file: /etc/cloudflared/creds.json\ningress:\n  - hostname: grafana.example.com\n    service: http://monitoring-grafana-1:3000\n  - service: http_status:404\n", uid: 65532, gid: 65532);
            tree.Folder("/tmp", 0x3FF);
            tree.Folder("/home/nonroot", 0x1ED, 65532, 65532);
            return root;
        }

        tree.File("/bin/sh", new byte[1024], 0x1ED);
        tree.File("/etc/hostname", container.Id[..12] + "\n");
        tree.File("/etc/hosts", $"127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n172.20.0.5\t{container.Id[..12]}\n");
        tree.File("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\npostgres:x:999:999::/var/lib/postgresql:/bin/bash\n");
        tree.File("/usr/lib/os-release", "PRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\nNAME=\"Debian GNU/Linux\"\nVERSION_ID=\"13\"\nID=debian\n");
        tree.Link("/etc/os-release", "../usr/lib/os-release");
        tree.Folder("/tmp", 0x3FF);
        tree.Folder("/root", 0x1C0);
        tree.Folder("/var/log", 0x1ED);
        tree.Folder("/home", 0x1ED);
        tree.Folder("/srv", 0x1ED);
        switch (container.Kind)
        {
            case Kind.Nginx:
                tree.File("/etc/nginx/nginx.conf", "user  nginx;\nworker_processes  auto;\n\nevents {\n    worker_connections  1024;\n}\n\nhttp {\n    include       /etc/nginx/mime.types;\n    sendfile        on;\n    include /etc/nginx/conf.d/*.conf;\n}\n");
                tree.File("/etc/nginx/conf.d/default.conf", "server {\n    listen       80;\n    server_name  shop.example.com;\n\n    location / {\n        proxy_pass http://api:3000;\n    }\n\n    location /uploads/ {\n        alias /srv/uploads/;\n    }\n}\n");
                tree.File("/usr/share/nginx/html/index.html", "<!DOCTYPE html>\n<html>\n<head><title>Welcome to nginx!</title></head>\n<body><h1>Welcome to nginx!</h1></body>\n</html>\n");
                tree.File("/usr/share/nginx/html/50x.html", "<!DOCTYPE html>\n<html><body><h1>An error occurred.</h1></body></html>\n");
                break;
            case Kind.Api or Kind.Worker or Kind.Migration or Kind.Crashing:
                tree.Folder("/srv/app", 0x1ED, Node, Node);
                tree.File("/srv/app/package.json", "{\n  \"name\": \"shop-api\",\n  \"version\": \"3.8.1\",\n  \"type\": \"module\",\n  \"scripts\": { \"start\": \"node server.js\" }\n}\n", uid: Node, gid: Node);
                tree.File("/srv/app/.npmrc", "fund=false\naudit=false\n", uid: Node, gid: Node);
                tree.Folder("/srv/app/node_modules/express", 0x1ED, Node, Node);
                tree.File("/srv/app/node_modules/express/package.json", "{ \"name\": \"express\", \"version\": \"5.1.0\" }\n", uid: Node, gid: Node);
                var script = container.Kind switch
                {
                    Kind.Api => ("server.js", "import express from 'express';\n\nconst app = express();\napp.get('/api/health', (_req, res) => res.json({ ok: true }));\napp.listen(process.env.PORT ?? 3000);\n"),
                    Kind.Worker => ("worker.js", "import { Queue } from './queue.js';\n\nfor await (const job of new Queue(process.env.QUEUE_URL)) {\n  await job.run();\n}\n"),
                    Kind.Migration => ("migrate.js", "import { migrate } from './db.js';\n\nawait migrate({ to: 'latest' });\nconsole.log('Migrations are up to date.');\n"),
                    _ => ("sender.js", "import { send } from './mail.js';\n\nawait send(process.env.SMTP_URL);\n"),
                };
                tree.File("/srv/app/" + script.Item1, script.Item2, uid: Node, gid: Node);
                if (container.Kind == Kind.Api)
                {
                    tree.Link("/srv/app/uploads", "/srv/uploads", Node, Node);
                }

                if (container.Mounts.All(mount => mount.Destination != "/srv/uploads"))
                {
                    // The image's own uploads folder, laid out like the shop's volume.
                    InMemoryFileTree.Folder(root, "/srv", 0x1ED, 0, 0, at).Children["uploads"] = SeedVolume("shop_uploads");
                }

                break;
            case Kind.Postgres:
                tree.File("/usr/local/bin/docker-entrypoint.sh", "#!/usr/bin/env bash\nset -Eeo pipefail\nexec \"$@\"\n", 0x1ED);
                break;
            case Kind.Grafana:
                tree.File("/etc/grafana/grafana.ini", "[server]\nroot_url = https://grafana.example.com\n\n[security]\nadmin_user = admin\n", 0x1A4, 472, 0);
                tree.Folder("/var/lib/grafana/plugins", 0x1ED, 472, 0);
                tree.File("/var/lib/grafana/grafana.db", new byte[24 * 1024], 0x1A0, 472, 0);
                break;
            case Kind.Prometheus:
                tree.File("/etc/prometheus/prometheus.yml", "global:\n  scrape_interval: 15s\n\nscrape_configs:\n  - job_name: prometheus\n    static_configs:\n      - targets: ['localhost:9090']\n");
                break;
            case Kind.Quiet:
                tree.File("/root/.bashrc", "export PS1='\\u@\\h:\\w\\$ '\nalias ll='ls -la'\n", 0x1A4);
                tree.File("/srv/notes.txt", "Things to check after the upgrade:\n- backups ran\n- certificates renewed\n");
                break;
            default:
                break;
        }

        foreach (var mount in container.Mounts.Where(m => m.Name is not null))
        {
            var parent = InMemoryFileTree.Folder(root, Parent(mount.Destination), 0x1ED, 0, 0, at);
            parent.Children[mount.Destination[(mount.Destination.LastIndexOf('/') + 1)..]] = VolumeRoot(mount.Name!);
        }

        return root;
    }

    private static string Parent(string path) => path.LastIndexOf('/') <= 0 ? "/" : path[..path.LastIndexOf('/')];

    /// <summary>A volume's files, by its name; a volume nobody seeded starts empty.</summary>
    private MemoryDirectory SeedVolume(string volume)
    {
        var at = NowMs - (long)TimeSpan.FromDays(2).TotalMilliseconds;
        var root = new MemoryDirectory { Permissions = 0x1ED, MtimeMs = at };
        var tree = new TreeWriter(root, at);
        switch (volume)
        {
            case "shop_uploads":
                root.Uid = root.Gid = Node;
                tree.File("/invoices/2026-09.pdf", "%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", uid: Node, gid: Node);
                tree.File("/invoices/2026-08.pdf", "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n", uid: Node, gid: Node);
                tree.File("/products/blue-mug.jpg", [0xFF, 0xD8, 0xFF, 0xE0, .. new byte[2048], 0xFF, 0xD9], uid: Node, gid: Node);
                tree.File("/products/green-tote.jpg", [0xFF, 0xD8, 0xFF, 0xE0, .. new byte[4096], 0xFF, 0xD9], uid: Node, gid: Node);
                tree.Folder("/avatars", 0x1ED, Node, Node);
                tree.Link("/latest-invoice.pdf", "invoices/2026-09.pdf", Node, Node);
                tree.Link("/old-banner.png", "banners/2025-summer.png", Node, Node);
                foreach (var folder in new[] { "invoices", "products" })
                {
                    root.Children[folder].Uid = root.Children[folder].Gid = Node;
                }

                break;
            case "shop_db-data":
                root.Uid = root.Gid = Postgres;
                root.Permissions = 0x1C0;
                tree.File("/PG_VERSION", "17\n", 0x180, Postgres, Postgres);
                tree.File("/postgresql.conf", "listen_addresses = '*'\nmax_connections = 100\nshared_buffers = 128MB\n", 0x180, Postgres, Postgres);
                tree.File("/pg_hba.conf", "local all all trust\nhost all all all scram-sha-256\n", 0x180, Postgres, Postgres);
                tree.Folder("/base/1", 0x1C0, Postgres, Postgres);
                tree.Folder("/global", 0x1C0, Postgres, Postgres);
                tree.Folder("/pg_wal", 0x1C0, Postgres, Postgres);
                tree.File("/base/1/16384", new byte[8192], 0x180, Postgres, Postgres);
                root.Children["base"].Uid = root.Children["base"].Gid = Postgres;
                break;
            case "monitoring_prometheus-data":
                root.Uid = root.Gid = Nobody;
                tree.File("/queries.active", new byte[1024], 0x1A4, Nobody, Nobody);
                tree.Folder("/wal", 0x1ED, Nobody, Nobody);
                tree.Folder("/chunks_head", 0x1ED, Nobody, Nobody);
                tree.File("/wal/00000042", new byte[16 * 1024], 0x1A4, Nobody, Nobody);
                break;
            default:
                break;
        }

        return root;
    }

    /// <summary>The helper's own root: busybox, and its volume mounted at /data.</summary>
    private MemoryDirectory BusyboxRoot()
    {
        var root = new MemoryDirectory { Permissions = 0x1ED, MtimeMs = NowMs };
        var tree = new TreeWriter(root, NowMs);
        tree.File("/bin/busybox", new byte[1024], 0x1ED);
        tree.Link("/bin/sh", "busybox");
        tree.File("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/home:/bin/false\n");
        tree.File("/etc/group", "root:x:0:\nnogroup:x:65534:\n");
        tree.Folder("/tmp", 0x3FF);
        return root;
    }

    /// <summary>Writes seed entries, making the folders on the way.</summary>
    private sealed class TreeWriter(MemoryDirectory root, long at)
    {
        public void File(string path, string content, int permissions = 0x1A4, int uid = 0, int gid = 0) =>
            File(path, Encoding.UTF8.GetBytes(content), permissions, uid, gid);

        public void File(string path, byte[] content, int permissions = 0x1A4, int uid = 0, int gid = 0) =>
            Parent(path).Children[Name(path)] = new MemoryFile { Content = content, Permissions = permissions, Uid = uid, Gid = gid, MtimeMs = at };

        public void Link(string path, string target, int uid = 0, int gid = 0) =>
            Parent(path).Children[Name(path)] = new MemorySymlink(target) { Permissions = 0x1FF, Uid = uid, Gid = gid, MtimeMs = at };

        public void Folder(string path, int permissions, int uid = 0, int gid = 0)
        {
            var folder = InMemoryFileTree.Folder(root, path, 0x1ED, 0, 0, at);
            folder.Permissions = permissions;
            folder.Uid = uid;
            folder.Gid = gid;
        }

        private static string Name(string path) => path[(path.LastIndexOf('/') + 1)..];

        private MemoryDirectory Parent(string path) =>
            InMemoryFileTree.Folder(root, path.LastIndexOf('/') <= 0 ? "/" : path[..path.LastIndexOf('/')], 0x1ED, 0, 0, at);
    }
}
