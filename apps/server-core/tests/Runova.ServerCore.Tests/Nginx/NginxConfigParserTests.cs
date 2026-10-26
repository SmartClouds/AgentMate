using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// The snippet allowlist is only as good as the parser under it: if it read a snippet differently
/// from nginx, a directive could hide from the checks. These cases follow nginx's own tokenizer
/// (ngx_conf_read_token) through quotes, escapes, comments and braces.
/// </summary>
public sealed class NginxConfigParserTests
{
    [Fact]
    public void Statements_and_blocks_become_directives_with_the_line_they_start_on()
    {
        var directives = NginxConfigParser.Parse("add_header X-A one;\nlocation /api {\n    return 204;\n}\n");

        Assert.Collection(
            directives,
            first =>
            {
                Assert.Equal("add_header", first.Name);
                Assert.Equal(["X-A", "one"], first.Arguments);
                Assert.Equal(1, first.Line);
                Assert.Null(first.Block);
            },
            second =>
            {
                Assert.Equal("location", second.Name);
                Assert.Equal(["/api"], second.Arguments);
                Assert.Equal(2, second.Line);
                var inner = Assert.Single(second.Block!);
                Assert.Equal("return", inner.Name);
                Assert.Equal(["204"], inner.Arguments);
                Assert.Equal(3, inner.Line);
            });
    }

    [Theory]
    [InlineData("\"include\" /etc/passwd;", "include")]
    [InlineData("'include' /etc/passwd;", "include")]
    [InlineData("\"a b\" c;", "a b")]
    public void Quoted_directive_names_are_unquoted_the_way_nginx_reads_them(string text, string name)
    {
        var directive = Assert.Single(NginxConfigParser.Parse(text));

        Assert.Equal(name, directive.Name);
    }

    [Theory]
    [InlineData("a \"b c\";", "b c")]
    [InlineData("a 'b \"c\"';", "b \"c\"")]
    [InlineData("a \"b\\\"c\";", "b\"c")]
    [InlineData("a 'it\\'s';", "it's")]
    [InlineData("a \"back\\\\slash\";", "back\\slash")]
    [InlineData("a b\\;c;", "b\\;c")]
    [InlineData("a b#c;", "b#c")]
    [InlineData("a ${b}c;", "${b}c")]
    [InlineData("a b};", "b}")]
    [InlineData("a (\"b\");", "(\"b\")")]
    [InlineData("a \"\";", "")]
    [InlineData("a '';", "")]
    [InlineData("a inc\\lude;", "inc\\lude")]
    public void Arguments_keep_or_drop_quotes_and_escapes_exactly_like_nginx(string text, string argument)
    {
        var directive = Assert.Single(NginxConfigParser.Parse(text));

        Assert.Equal("a", directive.Name);
        Assert.Equal([argument], directive.Arguments);
    }

    [Theory]
    [InlineData("a \"x\\ny\";", "x\ny")]
    [InlineData("a \"x\\ry\";", "x\ry")]
    [InlineData("a \"x\\ty\";", "x\ty")]
    [InlineData("a x\\ny;", "x\ny")]
    public void Backslash_escapes_decode_to_real_control_characters(string text, string argument)
    {
        var directive = Assert.Single(NginxConfigParser.Parse(text));

        Assert.Equal([argument], directive.Arguments);
    }

    [Fact]
    public void A_comment_inside_a_statement_hides_the_rest_of_its_line_only()
    {
        var directive = Assert.Single(NginxConfigParser.Parse("a b #c;\n include x;"));

        Assert.Equal("a", directive.Name);
        Assert.Equal(["b", "include", "x"], directive.Arguments);
    }

    [Fact]
    public void A_comment_after_a_statement_runs_to_the_end_of_the_line()
    {
        var directives = NginxConfigParser.Parse("a b; # c; include x;\nd;");

        Assert.Equal(["a", "d"], directives.Select(d => d.Name));
    }

    [Fact]
    public void A_brace_straight_after_a_word_opens_a_block()
    {
        var directive = Assert.Single(NginxConfigParser.Parse("a b{ c; }"));

        Assert.Equal(["b"], directive.Arguments);
        Assert.Equal("c", Assert.Single(directive.Block!).Name);
    }

    [Fact]
    public void A_regex_with_braces_must_be_quoted_or_the_brace_opens_a_block()
    {
        var quoted = Assert.Single(NginxConfigParser.Parse("location ~ \"^/a{2}$\" { }"));
        Assert.Equal(["~", "^/a{2}$"], quoted.Arguments);
        Assert.Empty(quoted.Block!);

        Assert.Throws<NginxSyntaxException>(() => NginxConfigParser.Parse("location ~ ^/a{2}$ { }"));
    }

    [Fact]
    public void A_closing_quote_then_parenthesis_starts_a_new_word()
    {
        var directive = Assert.Single(NginxConfigParser.Parse("if ($a = \"b\") { return 403; }"));

        Assert.Equal("if", directive.Name);
        Assert.Equal(["($a", "=", "b", ")"], directive.Arguments);
    }

    [Fact]
    public void Lines_are_counted_on_line_feeds_including_those_inside_quotes()
    {
        var directives = NginxConfigParser.Parse("a \"x\n\ny\";\nb c;");

        Assert.Equal(4, directives[1].Line);
    }

    [Fact]
    public void Carriage_returns_are_whitespace_and_do_not_count_as_lines()
    {
        var directives = NginxConfigParser.Parse("a b;\r\nc d;\re f;");

        Assert.Equal(["a", "c", "e"], directives.Select(d => d.Name));
        Assert.Equal([1, 2, 2], directives.Select(d => d.Line));
    }

    [Fact]
    public void Empty_text_and_comments_only_hold_no_directives()
    {
        Assert.Empty(NginxConfigParser.Parse(string.Empty));
        Assert.Empty(NginxConfigParser.Parse("# nothing here\n   \n\t# still nothing\n"));
    }

    [Theory]
    [InlineData("\"abc\"def;", 1, "unexpected \"d\"")]
    [InlineData("a \"b\"c;", 1, "unexpected \"c\"")]
    [InlineData("}", 1, "unexpected \"}\"")]
    [InlineData("a {", 1, "unexpected end of file, expecting \"}\"")]
    [InlineData("a b", 1, "unexpected end of file, expecting \";\" or \"}\"")]
    [InlineData(";", 1, "unexpected \";\"")]
    [InlineData("a;;", 1, "unexpected \";\"")]
    [InlineData("{ a; }", 1, "unexpected \"{\"")]
    [InlineData("a b }", 1, "unexpected \"}\"")]
    [InlineData("a;\nb;\n}\n", 3, "unexpected \"}\"")]
    [InlineData("a \"unterminated;\n", 2, "unexpected end of file, expecting \";\" or \"}\"")]
    public void Broken_syntax_is_refused_with_the_line_nginx_would_name(string text, int line, string message)
    {
        var error = Assert.Throws<NginxSyntaxException>(() => NginxConfigParser.Parse(text));

        Assert.Equal(line, error.Line);
        Assert.Equal(message, error.Reason);
    }

    [Fact]
    public void Blocks_nested_deeper_than_the_limit_are_refused()
    {
        var depth = NginxConfigParser.MaxDepth + 1;
        var text = string.Concat(Enumerable.Repeat("a {", depth)) + string.Concat(Enumerable.Repeat("}", depth));

        var error = Assert.Throws<NginxSyntaxException>(() => NginxConfigParser.Parse(text));

        Assert.Contains("nested", error.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Blocks_up_to_the_limit_are_fine()
    {
        var depth = NginxConfigParser.MaxDepth;
        var text = string.Concat(Enumerable.Repeat("a {", depth)) + string.Concat(Enumerable.Repeat("}", depth));

        Assert.Single(NginxConfigParser.Parse(text));
    }
}
