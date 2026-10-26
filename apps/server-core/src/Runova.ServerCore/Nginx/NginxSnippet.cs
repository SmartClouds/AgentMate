using System.Collections.Frozen;
using System.Globalization;
using System.Text;

namespace Runova.ServerCore.Nginx;

/// <summary>Where a snippet is included: directly in the site's server block, or in its main location.</summary>
internal enum NginxSnippetContext
{
    Server,
    Location,
}

/// <param name="SiteFolder">The only folder <c>root</c> and <c>alias</c> may point into.</param>
/// <param name="Upstreams">The checks a <c>proxy_pass</c> in a snippet goes through, the same as the site's own upstream.</param>
internal sealed record NginxSnippetRules(string SiteFolder, UpstreamPolicy Upstreams);

/// <summary>One reason a snippet cannot be used, on the line it applies to.</summary>
/// <param name="Directive">The directive refused, or null when the text itself is broken.</param>
internal sealed record NginxSnippetProblem(int Line, string? Directive, string Reason)
{
    public override string ToString() =>
        Directive is null ? $"Line {Line}: {Reason}" : $"Line {Line}: {Directive}: {Reason}";
}

/// <summary>
/// The custom snippet allowlist. A snippet ends up in configuration that nginx loads as root, so it
/// may only use directives known to be harmless, in the places nginx accepts them, with arguments
/// that cannot read or write files outside the site, run code, or send requests somewhere the
/// site's own upstream could not go. Anything unknown is refused, and every refusal says why.
/// </summary>
/// <remarks>
/// This only decides whether a snippet is safe to hand to nginx. Whether nginx accepts it (a
/// duplicate directive, a time written wrongly) is for <c>nginx -t</c> to say.
/// </remarks>
internal static class NginxSnippet
{
    public const int MaxLength = 65536;

    private static readonly FrozenDictionary<string, Rule> _rules = BuildRules();

    private static readonly FrozenSet<string> _methods = FrozenSet.Create(
        StringComparer.Ordinal,
        "GET", "HEAD", "POST", "PUT", "DELETE", "MKCOL", "COPY", "MOVE", "OPTIONS", "PROPFIND", "PROPPATCH", "LOCK", "UNLOCK", "PATCH");

    /// <summary>
    /// Variables nginx has already normalized, so they can never carry a .. that climbs out of
    /// the site. Request headers, cookies and arguments arrive exactly as a visitor sent them.
    /// </summary>
    private static readonly FrozenSet<string> _normalizedVariables = FrozenSet.Create(
        StringComparer.Ordinal,
        "uri", "args", "is_args", "query_string");

    [Flags]
    private enum Places
    {
        None = 0,
        Server = 1,
        Location = 2,
        IfInServer = 4,
        IfInLocation = 8,
        LimitExcept = 16,
    }

    private enum BlockKind
    {
        None,
        Location,
        If,
        LimitExcept,
    }

    private enum LocationKind
    {
        Prefix,
        PrefixNoRegex,
        Exact,
        Regex,
        Named,
    }

    /// <summary>Snippets are stored and written with line feeds only, so lines here and in nginx's errors agree.</summary>
    public static string Normalize(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        return text.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    public static IReadOnlyList<NginxSnippetProblem> Check(string text, NginxSnippetContext context, NginxSnippetRules rules)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(rules);
        text = Normalize(text);

        if (text.Length > MaxLength)
        {
            return [new NginxSnippetProblem(1, null, $"The snippet is longer than {MaxLength} characters.")];
        }

        if (CharacterProblem(text) is { } characterProblem)
        {
            return [characterProblem];
        }

        IReadOnlyList<NginxDirective> directives;
        try
        {
            directives = NginxConfigParser.Parse(text);
        }
        catch (NginxSyntaxException error)
        {
            return [new NginxSnippetProblem(error.Line, null, $"nginx cannot read this: {error.Reason}.")];
        }

        var problems = new List<NginxSnippetProblem>();
        var scope = context == NginxSnippetContext.Server
            ? new Scope(Places.Server, null)
            : new Scope(Places.Location, new LocationInfo(LocationKind.Prefix, "/"));
        Walk(directives, scope, rules, problems);
        return problems;
    }

    private static void Walk(IReadOnlyList<NginxDirective> directives, Scope scope, NginxSnippetRules rules, List<NginxSnippetProblem> problems)
    {
        foreach (var directive in directives)
        {
            var problem = Judge(directive, scope, rules, out var inner);
            if (problem is not null)
            {
                problems.Add(new NginxSnippetProblem(directive.Line, directive.Name, problem));
                continue;
            }

            if (inner is not null && directive.Block is not null)
            {
                Walk(directive.Block, inner, rules, problems);
            }
        }
    }

    /// <summary>Why this directive cannot be used here, or null; <paramref name="inner"/> is where its block's contents live.</summary>
    private static string? Judge(NginxDirective directive, Scope scope, NginxSnippetRules rules, out Scope? inner)
    {
        inner = null;
        var name = directive.Name;

        if (!_rules.TryGetValue(name, out var rule))
        {
            return Forbidden(name) ?? $"{name} is not on the list of directives snippets may use.";
        }

        if ((rule.Places & scope.Place) == 0)
        {
            return rule.WrongPlace?.Invoke(scope, rules) ?? $"{name} cannot be used {Describe(scope.Place)}.";
        }

        var count = directive.Arguments.Count;
        if (count < rule.MinArguments || count > rule.MaxArguments)
        {
            return $"{name} takes {DescribeCount(rule.MinArguments, rule.MaxArguments)}, not {count}.";
        }

        if (rule.Block != BlockKind.None && directive.Block is null)
        {
            return $"{name} needs a block in braces.";
        }

        if (rule.Block == BlockKind.None && directive.Block is not null)
        {
            return $"{name} does not take a block.";
        }

        foreach (var argument in directive.Arguments)
        {
            if (argument.Any(IsControl))
            {
                return $"An argument of {name} contains a line break or another control character, which nginx would pass into headers or responses as is.";
            }
        }

        if (rule.Check?.Invoke(directive, scope, rules) is { } problem)
        {
            return problem;
        }

        inner = rule.Block switch
        {
            BlockKind.Location => new Scope(Places.Location, ParseLocation(directive.Arguments)),
            BlockKind.If => new Scope(scope.Place == Places.Server ? Places.IfInServer : Places.IfInLocation, scope.Location),
            BlockKind.LimitExcept => new Scope(Places.LimitExcept, scope.Location),
            _ => null,
        };
        return null;
    }

    /// <summary>Directives refused on sight, with the reason in words.</summary>
    private static string? Forbidden(string name)
    {
        if (name == "include")
        {
            return "include reads other files into the configuration, and nginx loads them as root.";
        }

        if (name == "load_module")
        {
            return "load_module loads code into nginx.";
        }

        if (name.StartsWith("lua_", StringComparison.Ordinal)
            || name.Contains("_by_lua", StringComparison.Ordinal)
            || name.StartsWith("perl", StringComparison.Ordinal)
            || name.StartsWith("js_", StringComparison.Ordinal))
        {
            return $"{name} runs code inside nginx (Lua, Perl and njs are not allowed in snippets).";
        }

        if (name.EndsWith("_log", StringComparison.Ordinal))
        {
            return $"{name} writes files as root anywhere on the server; only access_log off is allowed.";
        }

        if (name.EndsWith("_pass", StringComparison.Ordinal))
        {
            return $"{name} connects to another kind of backend; only proxy_pass is allowed, with the same checks as the site's upstream.";
        }

        if (name is "listen" or "server_name" or "http2" or "http3" or "auth_basic" or "limit_req" or "limit_conn"
            || name.StartsWith("ssl_", StringComparison.Ordinal)
            || name.StartsWith("proxy_ssl", StringComparison.Ordinal)
            || name.StartsWith("quic", StringComparison.Ordinal))
        {
            return $"{name} comes from the site's settings in Runova, not from a snippet.";
        }

        if (name is "proxy_store" or "proxy_store_access" or "client_body_in_file_only"
            || name.EndsWith("_temp_path", StringComparison.Ordinal)
            || name.EndsWith("_cache_path", StringComparison.Ordinal))
        {
            return $"{name} writes files on the server.";
        }

        if (name is "auth_basic_user_file" or "secure_link_secret" or "ssi" or "xslt_stylesheet" or "geoip_country" or "geoip_city")
        {
            return $"{name} reads files from the server.";
        }

        if (name is "resolver" or "resolver_timeout")
        {
            return $"{name} changes how nginx looks up upstream names, and upstreams are checked when a site is saved.";
        }

        if (name is "server" or "http" or "events" or "stream" or "mail" or "upstream" or "map" or "geo" or "split_clients"
            or "log_format" or "limit_req_zone" or "limit_conn_zone" or "types" or "user" or "worker_processes" or "env")
        {
            return $"{name} belongs at the top level of the configuration, which Runova writes; a snippet goes inside a site.";
        }

        return null;
    }

    private static FrozenDictionary<string, Rule> BuildRules()
    {
        const Places sl = Places.Server | Places.Location;
        const Places sli = sl | Places.IfInLocation;
        const Places anyIf = sl | Places.IfInServer | Places.IfInLocation;
        const int many = int.MaxValue;

        var rules = new Dictionary<string, Rule>(StringComparer.Ordinal)
        {
            ["add_header"] = new(sli, 2, 3, Check: CheckAddHeader),
            ["proxy_set_header"] = new(sl, 2, 2, Check: CheckHeaderName),
            ["proxy_hide_header"] = new(sl, 1, 1, Check: CheckHeaderName),
            ["proxy_pass_header"] = new(sl, 1, 1, Check: CheckHeaderName),
            ["proxy_connect_timeout"] = new(sl, 1, 1),
            ["proxy_read_timeout"] = new(sl, 1, 1),
            ["proxy_send_timeout"] = new(sl, 1, 1),
            ["proxy_buffering"] = new(sl, 1, 1),
            ["proxy_request_buffering"] = new(sl, 1, 1),
            ["proxy_buffer_size"] = new(sl, 1, 1),
            ["proxy_buffers"] = new(sl, 2, 2),
            ["proxy_busy_buffers_size"] = new(sl, 1, 1),
            ["proxy_max_temp_file_size"] = new(sl, 1, 1),
            ["proxy_http_version"] = new(sl, 1, 1),
            ["proxy_redirect"] = new(sl, 1, 2),
            ["proxy_intercept_errors"] = new(sl, 1, 1),
            ["proxy_cache"] = new(sl, 1, 1, Check: CheckProxyCacheOff),
            ["proxy_cache_bypass"] = new(sl, 1, many),
            ["proxy_no_cache"] = new(sl, 1, many),
            ["proxy_cache_valid"] = new(sl, 1, many),
            ["proxy_pass"] = new(Places.Location | Places.IfInLocation, 1, 1, Check: CheckProxyPass),
            ["client_max_body_size"] = new(sl, 1, 1),
            ["client_body_timeout"] = new(sl, 1, 1),
            ["send_timeout"] = new(sl, 1, 1),
            ["keepalive_timeout"] = new(sl, 1, 2),
            ["gzip"] = new(sli, 1, 1),
            ["gzip_types"] = new(sl, 1, many),
            ["gzip_min_length"] = new(sl, 1, 1),
            ["gzip_comp_level"] = new(sl, 1, 1),
            ["gzip_proxied"] = new(sl, 1, many),
            ["gzip_vary"] = new(sl, 1, 1),
            ["expires"] = new(sli, 1, 2),
            ["etag"] = new(sl, 1, 1),
            ["if_modified_since"] = new(sl, 1, 1),
            ["charset"] = new(sli, 1, 1),
            ["default_type"] = new(sl, 1, 1),
            ["index"] = new(sl, 1, many, Check: CheckIndex),
            ["try_files"] = new(sl, 2, many, Check: CheckTryFiles),
            ["autoindex"] = new(sl, 1, 1),
            ["root"] = new(Places.Location, 1, 1, Check: CheckRoot, WrongPlace: RootWrongPlace),
            ["alias"] = new(Places.Location, 1, 1, Check: CheckAlias),
            ["error_page"] = new(sli, 2, many, Check: CheckErrorPage),
            ["return"] = new(anyIf, 1, 2),
            ["rewrite"] = new(anyIf, 2, 3, Check: CheckRewrite),
            ["set"] = new(anyIf, 2, 2, Check: CheckSet),
            ["break"] = new(anyIf, 0, 0),
            ["if"] = new(sl, 1, many, BlockKind.If, CheckIf),
            ["location"] = new(sl, 1, 2, BlockKind.Location, CheckLocation),
            ["limit_except"] = new(Places.Location, 1, many, BlockKind.LimitExcept, CheckLimitExcept),
            ["allow"] = new(sl | Places.LimitExcept, 1, 1, Check: CheckAccessRule),
            ["deny"] = new(sl | Places.LimitExcept, 1, 1, Check: CheckAccessRule),
            ["limit_rate"] = new(sli, 1, 1),
            ["limit_rate_after"] = new(sli, 1, 1),
            ["sub_filter"] = new(sl, 2, 2),
            ["sub_filter_once"] = new(sl, 1, 1),
            ["sub_filter_types"] = new(sl, 1, many),
            ["sub_filter_last_modified"] = new(sl, 1, 1),
            ["internal"] = new(Places.Location, 0, 0),
            ["access_log"] = new(sli | Places.LimitExcept, 1, 1, Check: CheckAccessLog),
            ["log_not_found"] = new(sl, 1, 1),
            ["satisfy"] = new(sl, 1, 1),
        };

        return rules.ToFrozenDictionary(StringComparer.Ordinal);
    }

    private static string? CheckAddHeader(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        if (CheckHeaderName(directive, scope, rules) is { } problem)
        {
            return problem;
        }

        return directive.Arguments.Count == 3 && directive.Arguments[2] != "always"
            ? "The third argument of add_header can only be always."
            : null;
    }

    private static string? CheckHeaderName(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var header = directive.Arguments[0];
        return header.Length is > 0 and <= 128 && header.All(c => char.IsAsciiLetterOrDigit(c) || c == '-')
            ? null
            : $"'{header}' is not a header name; use letters, digits and hyphens.";
    }

    private static string? CheckProxyCacheOff(NginxDirective directive, Scope scope, NginxSnippetRules rules) =>
        directive.Arguments[0] == "off"
            ? null
            : "Only proxy_cache off is allowed; the site's cache is set in its Performance settings.";

    private static string? CheckAccessLog(NginxDirective directive, Scope scope, NginxSnippetRules rules) =>
        directive.Arguments[0] == "off"
            ? null
            : "access_log with a path writes files as root anywhere on the server; only access_log off is allowed.";

    private static string? CheckProxyPass(NginxDirective directive, Scope scope, NginxSnippetRules rules) =>
        rules.Upstreams.TryParseUrl(directive.Arguments[0], out _, out var problem) ? null : problem;

    private static string RootWrongPlace(Scope scope, NginxSnippetRules rules) =>
        scope.Place == Places.Server
            ? $"root for the whole server is the site folder ({rules.SiteFolder}) already; set root inside a location instead."
            : $"root cannot be used {Describe(scope.Place)}.";

    private static string? CheckRoot(NginxDirective directive, Scope scope, NginxSnippetRules rules) =>
        FolderProblem("root", directive.Arguments[0], rules.SiteFolder);

    private static string? CheckAlias(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var alias = directive.Arguments[0];
        if (FolderProblem("alias", alias, rules.SiteFolder) is { } problem)
        {
            return problem;
        }

        // A prefix location without a trailing slash and an alias with one lets /files../x climb
        // one folder up ("off by slash"), so both must end the same way, and regex or named
        // locations, which would need captures, are out.
        var location = scope.Location;
        var slashesMatch = location is { Kind: LocationKind.Prefix or LocationKind.PrefixNoRegex }
            && location.Path.EndsWith('/') == alias.EndsWith('/');
        var exact = location is { Kind: LocationKind.Exact };
        return slashesMatch || exact
            ? null
            : "alias only works here in a prefix location (like location /files/) whose path and alias both end with a slash; otherwise a request can climb out of the folder.";
    }

    /// <summary>Paths for root and alias: absolute, plain characters, no dot segments or variables, inside the site folder.</summary>
    private static string? FolderProblem(string name, string path, string siteFolder)
    {
        if (path.Contains('$', StringComparison.Ordinal))
        {
            return $"{name} may not use variables, so it always stays inside the site folder {siteFolder}.";
        }

        var plain = path.StartsWith('/')
            && path.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-' or '/' or '@' or '+' or '~');
        var segments = path.TrimEnd('/').Split('/')[1..];
        var clean = plain && segments.All(segment => segment is not ("" or "." or ".."));
        var inside = path == siteFolder || path.StartsWith(siteFolder + "/", StringComparison.Ordinal);
        return clean && inside
            ? null
            : $"{name} must be a plain path inside the site folder {siteFolder}, without . or .. parts.";
    }

    private static string? CheckTryFiles(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var arguments = directive.Arguments;
        for (var i = 0; i < arguments.Count; i++)
        {
            var argument = arguments[i];
            var last = i == arguments.Count - 1;
            if (last && (argument.StartsWith('@') || (argument.StartsWith('=') && argument[1..].All(char.IsAsciiDigit))))
            {
                continue;
            }

            var variables = Variables(argument);
            var fine = (argument.StartsWith('/') || argument.StartsWith("$uri", StringComparison.Ordinal))
                && variables.All(_normalizedVariables.Contains)
                && !argument.Split('/').Any(segment => segment is "." or "..");
            if (!fine)
            {
                return $"'{argument}' is not a request path inside the site; try_files may only use $uri, $args, $is_args, $query_string and fixed paths without . or .. parts.";
            }
        }

        return null;
    }

    /// <summary>
    /// A rewrite that stays inside nginx hands the new path to whatever serves it, the static file
    /// module included, which maps it onto root as it is. Redirects go back to the browser.
    /// </summary>
    private static string? CheckRewrite(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var replacement = directive.Arguments[1];
        var flag = directive.Arguments.Count == 3 ? directive.Arguments[2] : null;
        if (flag is not (null or "last" or "break" or "redirect" or "permanent"))
        {
            return $"'{flag}' is not a rewrite flag; use last, break, redirect or permanent.";
        }

        var redirect = flag is "redirect" or "permanent" || IsAbsoluteUrl(replacement);
        return redirect ? null : InternalPathProblem("rewrite", replacement);
    }

    private static string? CheckErrorPage(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var arguments = directive.Arguments;
        foreach (var code in arguments.Take(arguments.Count - 1))
        {
            var number = code.StartsWith('=') ? code[1..] : code;
            if (!(number.Length == 0 && code == "=") && !(number.Length == 3 && number.All(char.IsAsciiDigit)))
            {
                return $"'{code}' is not a status code for error_page.";
            }
        }

        var target = arguments[^1];
        return target.StartsWith('@') || IsAbsoluteUrl(target) ? null : InternalPathProblem("error_page", target);
    }

    private static string? CheckIndex(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        foreach (var file in directive.Arguments)
        {
            if (file is "." or ".." || !file.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-'))
            {
                return $"index takes plain file names like index.html; '{file}' could point outside the site.";
            }
        }

        return null;
    }

    private static string? InternalPathProblem(string name, string path)
    {
        var withoutQuery = path.Split('?')[0];
        var fine = Variables(path).All(variable => _normalizedVariables.Contains(variable) || variable is [>= '1' and <= '9'])
            && !withoutQuery.Split('/').Any(segment => segment is "." or "..");
        return fine
            ? null
            : $"{name} could send the request to a path outside the site: a path inside nginx may not have . or .. parts and may only use $uri, $args, $is_args, $query_string and regex captures like $1, never values a visitor sends.";
    }

    private static bool IsAbsoluteUrl(string value) =>
        value.StartsWith("http://", StringComparison.Ordinal)
        || value.StartsWith("https://", StringComparison.Ordinal)
        || value.StartsWith("$scheme://", StringComparison.Ordinal);

    private static string? CheckSet(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var variable = directive.Arguments[0];
        return variable.Length > 1
            && variable[0] == '$'
            && (char.IsAsciiLetter(variable[1]) || variable[1] == '_')
            && variable[1..].All(c => char.IsAsciiLetterOrDigit(c) || c == '_')
            ? null
            : $"set needs a variable name like $name first, not '{variable}'.";
    }

    private static string? CheckIf(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var first = directive.Arguments[0];
        if (!first.StartsWith('('))
        {
            return "if needs its condition in parentheses.";
        }

        var test = first[1..];
        if (test.Length == 0 && directive.Arguments.Count > 1)
        {
            test = directive.Arguments[1];
        }

        return test is "-f" or "!-f" or "-d" or "!-d" or "-e" or "!-e" or "-x" or "!-x"
            ? "if may not test for files (-f, -d, -e, -x), which would reveal what exists on the server."
            : null;
    }

    private static string? CheckLocation(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var arguments = directive.Arguments;
        if (arguments.Count == 2 && arguments[0] is not ("=" or "~" or "~*" or "^~"))
        {
            return $"'{arguments[0]}' is not a location modifier; use =, ~, ~* or ^~.";
        }

        var location = ParseLocation(arguments);
        if (location.Path.Length == 0)
        {
            return "location needs a path.";
        }

        return location.Kind == LocationKind.Named && scope.Place != Places.Server
            ? "Named locations (@...) only work directly in the server block."
            : null;
    }

    private static string? CheckLimitExcept(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        foreach (var method in directive.Arguments)
        {
            if (!_methods.Contains(method))
            {
                return $"'{method}' is not an HTTP method limit_except knows.";
            }
        }

        return null;
    }

    private static string? CheckAccessRule(NginxDirective directive, Scope scope, NginxSnippetRules rules)
    {
        var value = directive.Arguments[0];
        return value == "all" || NginxAddresses.TryParseNetwork(value, out _, out _)
            ? null
            : $"'{value}' is not all, an IP address or a network like 203.0.113.0/24.";
    }

    /// <summary>How nginx reads a location's arguments (ngx_http_core_location), modifier glued on or not.</summary>
    private static LocationInfo ParseLocation(IReadOnlyList<string> arguments)
    {
        if (arguments.Count == 2)
        {
            return arguments[0] switch
            {
                "=" => new LocationInfo(LocationKind.Exact, arguments[1]),
                "^~" => new LocationInfo(LocationKind.PrefixNoRegex, arguments[1]),
                _ => new LocationInfo(LocationKind.Regex, arguments[1]),
            };
        }

        var path = arguments[0];
        if (path.StartsWith('='))
        {
            return new LocationInfo(LocationKind.Exact, path[1..]);
        }

        if (path.StartsWith("^~", StringComparison.Ordinal))
        {
            return new LocationInfo(LocationKind.PrefixNoRegex, path[2..]);
        }

        if (path.StartsWith("~*", StringComparison.Ordinal))
        {
            return new LocationInfo(LocationKind.Regex, path[2..]);
        }

        if (path.StartsWith('~'))
        {
            return new LocationInfo(LocationKind.Regex, path[1..]);
        }

        return path.StartsWith('@')
            ? new LocationInfo(LocationKind.Named, path)
            : new LocationInfo(LocationKind.Prefix, path);
    }

    /// <summary>The names of the variables an argument uses, written as $name or ${name}.</summary>
    private static List<string> Variables(string argument)
    {
        var names = new List<string>();
        for (var i = 0; i < argument.Length; i++)
        {
            if (argument[i] != '$')
            {
                continue;
            }

            var braced = i + 1 < argument.Length && argument[i + 1] == '{';
            var start = braced ? i + 2 : i + 1;
            var end = start;
            while (end < argument.Length && (char.IsAsciiLetterOrDigit(argument[end]) || argument[end] == '_'))
            {
                end++;
            }

            names.Add(argument[start..end]);
            i = end - 1;
        }

        return names;
    }

    /// <summary>
    /// Characters that are refused anywhere in a snippet: control characters (tab and line feed
    /// aside), carriage returns that do not end a line, and invisible formatting characters such as
    /// bidirectional overrides and zero-width spaces, which can make a snippet shown in the app
    /// read differently from what nginx sees.
    /// </summary>
    private static NginxSnippetProblem? CharacterProblem(string text)
    {
        var line = 1;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\n')
            {
                line++;
                continue;
            }

            if (c == '\t')
            {
                continue;
            }

            if (c == '\r')
            {
                return new NginxSnippetProblem(line, null, "The snippet has a carriage return that does not end a line; editors and nginx would count its lines differently.");
            }

            if (char.IsSurrogate(c))
            {
                if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                {
                    var category = CharUnicodeInfo.GetUnicodeCategory(text, i);
                    i++;
                    if (category == UnicodeCategory.Format)
                    {
                        return Invisible(line, char.ConvertToUtf32(text[i - 1], text[i]));
                    }

                    continue;
                }

                return new NginxSnippetProblem(line, null, "The snippet contains a broken character (an unpaired UTF-16 surrogate).");
            }

            if (IsControl(c))
            {
                return new NginxSnippetProblem(line, null, $"The snippet contains a control character ({CodePoint(c)}).");
            }

            var kind = CharUnicodeInfo.GetUnicodeCategory(c);
            if (kind is UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
            {
                return Invisible(line, c);
            }
        }

        return null;
    }

    private static NginxSnippetProblem Invisible(int line, int codePoint) =>
        new(line, null, $"The snippet contains an invisible character ({CodePoint(codePoint)}) that can make it read differently from what nginx sees.");

    private static bool IsControl(char c) => c < ' ' || (c >= '\u007f' && c <= '\u009f');

    private static string CodePoint(int value) => "U+" + value.ToString("X4", CultureInfo.InvariantCulture);

    private static string Describe(Places place) => place switch
    {
        Places.Server => "directly in the server block",
        Places.Location => "in a location",
        Places.IfInServer => "in an if block directly in the server",
        Places.IfInLocation => "in an if block in a location",
        Places.LimitExcept => "in limit_except",
        _ => "here",
    };

    private static string DescribeCount(int min, int max)
    {
        var builder = new StringBuilder();
        if (min == max)
        {
            builder.Append(CultureInfo.InvariantCulture, $"{min} argument{(min == 1 ? string.Empty : "s")}");
        }
        else if (max == int.MaxValue)
        {
            builder.Append(CultureInfo.InvariantCulture, $"at least {min} argument{(min == 1 ? string.Empty : "s")}");
        }
        else
        {
            builder.Append(CultureInfo.InvariantCulture, $"{min} to {max} arguments");
        }

        return builder.ToString();
    }

    private sealed record Scope(Places Place, LocationInfo? Location);

    private sealed record LocationInfo(LocationKind Kind, string Path);

    private sealed record Rule(
        Places Places,
        int MinArguments,
        int MaxArguments,
        BlockKind Block = BlockKind.None,
        Func<NginxDirective, Scope, NginxSnippetRules, string?>? Check = null,
        Func<Scope, NginxSnippetRules, string>? WrongPlace = null);
}
