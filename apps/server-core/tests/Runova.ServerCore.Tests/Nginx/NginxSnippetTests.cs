using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// Custom snippets go into a configuration nginx runs as root, so only directives on the allowlist
/// get through, and only in the places nginx allows them. Every refusal names the line and the
/// directive and says why in words.
/// </summary>
public sealed class NginxSnippetTests
{
    private const string SiteFolder = "/var/www/runova/sites/app";

    private static readonly NginxSnippetRules _rules = new(SiteFolder, UpstreamPolicy.Default);

    private static IReadOnlyList<NginxSnippetProblem> Server(string text) =>
        NginxSnippet.Check(text, NginxSnippetContext.Server, _rules);

    private static IReadOnlyList<NginxSnippetProblem> Location(string text) =>
        NginxSnippet.Check(text, NginxSnippetContext.Location, _rules);

    private static NginxSnippetProblem Refused(IReadOnlyList<NginxSnippetProblem> problems) => Assert.Single(problems);

    [Theory]
    [InlineData("add_header X-Frame-Options DENY always;")]
    [InlineData("add_header Content-Security-Policy \"default-src 'self'; img-src *\" always;")]
    [InlineData("client_max_body_size 50m;\nproxy_read_timeout 300s;")]
    [InlineData("location = /health {\n    access_log off;\n    return 200 \"healthy\";\n}")]
    [InlineData("location /static/ {\n    alias /var/www/runova/sites/app/static/;\n    expires 7d;\n}")]
    [InlineData("location /assets/ { root /var/www/runova/sites/app/public; try_files $uri $uri/ =404; }")]
    [InlineData("location /api/ { proxy_pass http://127.0.0.1:4000/; proxy_set_header X-Api yes; }")]
    [InlineData("location ~* \\.(png|jpg)$ { expires 30d; add_header Cache-Control \"public\"; }")]
    [InlineData("location @fallback { return 302 https://example.com/; }")]
    [InlineData("if ($request_method = POST) { return 405; }")]
    [InlineData("rewrite ^/old/(.*)$ /new/$1 permanent;")]
    [InlineData("error_page 502 503 /maintenance.html;")]
    [InlineData("gzip on;\ngzip_types text/plain application/json;\n# a comment\n\n")]
    [InlineData("allow 10.0.0.0/8;\nallow 2001:db8::/32;\ndeny all;")]
    [InlineData("")]
    public void Ordinary_server_snippets_pass(string text)
    {
        Assert.Empty(Server(text));
    }

    [Theory]
    [InlineData("proxy_set_header X-Snippet yes;\nadd_header X-From-Snippet on always;")]
    [InlineData("if ($http_user_agent ~* bot) { return 403; }")]
    [InlineData("limit_except GET POST { deny all; }")]
    [InlineData("location /api/ { proxy_pass http://127.0.0.1:4000/; }")]
    [InlineData("proxy_cache off;\nproxy_buffering off;")]
    [InlineData("sub_filter \"</body>\" \"<!-- served --></body>\";\nsub_filter_once on;")]
    public void Ordinary_location_snippets_pass(string text)
    {
        Assert.Empty(Location(text));
    }

    [Theory]
    [InlineData("include /etc/nginx/nginx.conf;", "include", "reads other files")]
    [InlineData("\"include\" /etc/passwd;", "include", "reads other files")]
    [InlineData("load_module modules/ngx_stream_module.so;", "load_module", "loads code")]
    [InlineData("access_log /etc/cron.d/evil;", "access_log", "writes files")]
    [InlineData("error_log /tmp/debug.log debug;", "error_log", "writes files")]
    [InlineData("content_by_lua_block { ngx.say(1); }", "content_by_lua_block", "runs code")]
    [InlineData("lua_code_cache off;", "lua_code_cache", "runs code")]
    [InlineData("perl_modules /opt/perl;", "perl_modules", "runs code")]
    [InlineData("js_import main.js;", "js_import", "runs code")]
    [InlineData("fastcgi_pass 127.0.0.1:9000;", "fastcgi_pass", "only proxy_pass")]
    [InlineData("listen 8080;", "listen", "site's settings")]
    [InlineData("server_name evil.example;", "server_name", "site's settings")]
    [InlineData("ssl_certificate /etc/shadow;", "ssl_certificate", "site's settings")]
    [InlineData("proxy_store /etc/cron.d/;", "proxy_store", "writes files")]
    [InlineData("client_body_temp_path /etc;", "client_body_temp_path", "writes files")]
    [InlineData("auth_basic_user_file /etc/shadow;", "auth_basic_user_file", "reads files")]
    [InlineData("resolver 1.1.1.1;", "resolver", "resolver")]
    [InlineData("server { listen 81; }", "server", "top level")]
    [InlineData("upstream x { server 127.0.0.1; }", "upstream", "top level")]
    [InlineData("frobnicate on;", "frobnicate", "not on the list")]
    [InlineData("Add_Header X y;", "Add_Header", "not on the list")]
    public void Dangerous_or_unknown_directives_are_refused_with_the_line_directive_and_reason(
        string text,
        string directive,
        string reason)
    {
        var problem = Refused(Server(text));

        Assert.Equal(1, problem.Line);
        Assert.Equal(directive, problem.Directive);
        Assert.Contains(reason, problem.Reason, StringComparison.Ordinal);
        Assert.Contains($"Line 1: {directive}: ", problem.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Access_log_may_only_be_switched_off()
    {
        Assert.Empty(Server("access_log off;"));
        Assert.Equal("access_log", Refused(Server("access_log off main;")).Directive);
    }

    [Theory]
    [InlineData("location /x/ { root /etc; }")]
    [InlineData("location /x/ { root /var/www/runova/sites/app2; }")]
    [InlineData("location /x/ { root /var/www/runova/sites/app/../other; }")]
    [InlineData("location /x/ { root /var/www/runova/sites/app/./x; }")]
    [InlineData("location /x/ { root /var/www/runova/sites//app; }")]
    [InlineData("location /x/ { root $document_root/x; }")]
    [InlineData("location /x/ { root relative/path; }")]
    [InlineData("location /x/ { alias /var/www/runova/sites/other/; }")]
    [InlineData("location /x/ { alias /var/www/runova/sites/app/$1/; }")]
    public void Root_and_alias_must_stay_inside_the_site_folder(string text)
    {
        var problem = Refused(Server(text));

        Assert.Contains(SiteFolder, problem.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Root_may_not_be_set_for_the_whole_server_because_the_site_already_sets_it()
    {
        var problem = Refused(Server("root /var/www/runova/sites/app/public;"));

        Assert.Equal("root", problem.Directive);
        Assert.Contains("inside a location", problem.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("location /img { alias /var/www/runova/sites/app/images/; }")]
    [InlineData("location /img/ { alias /var/www/runova/sites/app/images; }")]
    [InlineData("location ~ ^/img/(.*)$ { alias /var/www/runova/sites/app/images/; }")]
    public void Alias_needs_matching_trailing_slashes_so_requests_cannot_climb_out(string text)
    {
        var problem = Refused(Server(text));

        Assert.Equal("alias", problem.Directive);
        Assert.Contains("slash", problem.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("location /m/ { proxy_pass http://169.254.169.254/; }", "metadata")]
    [InlineData("location /m/ { proxy_pass http://[fd00:ec2::254]/; }", "metadata")]
    [InlineData("location /m/ { proxy_pass http://metadata.google.internal/; }", "metadata")]
    [InlineData("location /m/ { proxy_pass http://$host; }", "variable")]
    [InlineData("location /m/ { proxy_pass http://unix:/run/runova-core/core.sock:/; }", "Unix socket")]
    [InlineData("location /m/ { proxy_pass http://127.0.0.1:7810/; }", "core")]
    [InlineData("location /m/ { proxy_pass http://127.0.0.1:2375/; }", "Docker")]
    [InlineData("location /m/ { proxy_pass http://2852039166/; }", "numeric")]
    public void Proxy_pass_goes_through_the_same_checks_as_the_sites_upstream(string text, string reason)
    {
        var problem = Refused(Server(text));

        Assert.Equal("proxy_pass", problem.Directive);
        Assert.Contains(reason, problem.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("add_header X-A \"one\\r\\nSet-Cookie: stolen=1\";")]
    [InlineData("add_header X-A \"one\ntwo\";")]
    [InlineData("return 302 \"https://example.com/\\r\\nX: y\";")]
    public void Arguments_that_decode_to_line_breaks_are_refused(string text)
    {
        var problem = Refused(Server(text));

        Assert.Contains("control character", problem.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("add_header X-A \"a‮b\";", "invisible")]
    [InlineData("add_header X-A a​b;", "invisible")]
    [InlineData("﻿add_header X-A b;", "invisible")]
    [InlineData("add_header X-A a\0b;", "control character")]
    [InlineData("add_header X-A a;\rinclude /x;", "carriage return")]
    public void Characters_that_hide_what_a_snippet_does_are_refused(string text, string reason)
    {
        var problem = Refused(Server(text));

        Assert.Equal(1, problem.Line);
        Assert.Contains(reason, problem.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Windows_line_endings_are_fine()
    {
        Assert.Empty(Server("add_header X-A b;\r\nadd_header X-B c;\r\n"));
    }

    [Theory]
    [InlineData("if (-f /etc/passwd) { return 200; }")]
    [InlineData("if (!-e $request_filename) { return 404; }")]
    public void If_may_not_test_for_files(string text)
    {
        var problem = Refused(Location(text));

        Assert.Equal("if", problem.Directive);
        Assert.Contains("files", problem.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("alias /var/www/runova/sites/app/;", false, "alias")]
    [InlineData("internal;", false, "internal")]
    [InlineData("limit_except GET { deny all; }", false, "limit_except")]
    [InlineData("if ($x) { add_header X y; }", false, "add_header")]
    [InlineData("limit_except GET { proxy_pass http://127.0.0.1:4000; }", true, "proxy_pass")]
    [InlineData("proxy_pass http://127.0.0.1:4000;", false, "proxy_pass")]
    [InlineData("location @named { }", true, "location")]
    public void Directives_are_refused_where_nginx_would_not_take_them(
        string text,
        bool inLocation,
        string directive)
    {
        var problem = Refused(inLocation ? Location(text) : Server(text));

        Assert.Equal(directive, problem.Directive);
    }

    [Fact]
    public void Nested_refusals_name_their_own_line()
    {
        var problem = Refused(Server("location /a/ {\n    return 200;\n    include /etc/passwd;\n}\n"));

        Assert.Equal(3, problem.Line);
        Assert.Equal("include", problem.Directive);
    }

    [Fact]
    public void Every_refusal_is_reported_not_just_the_first()
    {
        var problems = Server("include /a;\nadd_header X y;\nload_module b;\n");

        Assert.Equal([1, 3], problems.Select(p => p.Line));
    }

    [Theory]
    [InlineData("}\n", 1)]
    [InlineData("location / {\n return 200;\n", 3)]
    [InlineData("add_header X \"y\"z;", 1)]
    public void Broken_syntax_is_reported_with_its_line(string text, int line)
    {
        var problem = Refused(Server(text));

        Assert.Equal(line, problem.Line);
        Assert.Null(problem.Directive);
    }

    [Fact]
    public void A_closing_brace_cannot_escape_into_the_surrounding_server_block()
    {
        var problems = Server("return 200;\n}\nserver {\n    listen 7810;\n");

        Assert.Equal(2, Assert.Single(problems).Line);
    }

    [Theory]
    [InlineData("try_files $uri /$http_x_file;")]
    [InlineData("try_files $uri /../../etc/passwd;")]
    public void Try_files_only_takes_request_paths_inside_the_site(string text)
    {
        var problem = Refused(Location($"location /x/ {{ {text} }}"));

        Assert.Equal("try_files", problem.Directive);
    }

    [Theory]
    [InlineData("rewrite ^ /../../etc/passwd last;", "rewrite")]
    [InlineData("rewrite ^ /$arg_path last;", "rewrite")]
    [InlineData("rewrite ^/(.*)$ /files/$http_x_file break;", "rewrite")]
    [InlineData("set $where /etc;\nrewrite ^ $where/passwd last;", "rewrite")]
    [InlineData("error_page 404 /../../etc/passwd;", "error_page")]
    [InlineData("error_page 404 /errors/$arg_page.html;", "error_page")]
    [InlineData("index ../../../../etc/passwd;", "index")]
    [InlineData("index $arg_file;", "index")]
    [InlineData("index sub/index.html;", "index")]
    public void Internal_paths_cannot_climb_out_of_the_site_or_follow_what_a_visitor_sends(string text, string directive)
    {
        var problem = Refused(Location($"location /x/ {{ {text} }}"));

        Assert.Equal(directive, problem.Directive);
        Assert.Contains("outside the site", problem.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("rewrite ^/old/(.*)$ /new/$1 permanent;")]
    [InlineData("rewrite ^/(.*)$ /app/$1 last;")]
    [InlineData("rewrite ^ https://$host$request_uri? permanent;")]
    [InlineData("rewrite ^ $scheme://$host/moved redirect;")]
    [InlineData("rewrite ^ /index.html?$args break;")]
    [InlineData("error_page 404 = @fallback;")]
    [InlineData("error_page 500 502 =200 /maintenance.html;")]
    [InlineData("error_page 404 https://example.com/missing?from=$uri;")]
    [InlineData("index index.html index.htm;")]
    public void Internal_paths_from_captures_and_normalized_variables_are_fine(string text)
    {
        Assert.Empty(Location($"location /x/ {{ {text} }}"));
    }

    [Fact]
    public void Oversized_snippets_are_refused()
    {
        var text = string.Concat(Enumerable.Repeat("gzip on;\n", (NginxSnippet.MaxLength / 9) + 1));

        var problem = Refused(Server(text));

        Assert.Contains("longer", problem.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Header_names_must_be_plain_tokens()
    {
        Assert.Equal("add_header", Refused(Server("add_header \"X A\" b;")).Directive);
        Assert.Equal("proxy_set_header", Refused(Location("proxy_set_header X:A b;")).Directive);
    }
}
