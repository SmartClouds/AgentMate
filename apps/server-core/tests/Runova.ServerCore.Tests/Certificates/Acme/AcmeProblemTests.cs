using System.Net;
using System.Text;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>ACME errors arrive as problem documents (RFC 8555 section 6.7) and leave as clear exceptions.</summary>
public sealed class AcmeProblemTests
{
    [Fact]
    public void A_problem_document_keeps_its_type_detail_and_status()
    {
        var problem = AcmeProblem.TryParse(
            """{"type":"urn:ietf:params:acme:error:badCSR","detail":"The key is too short","status":400}"""u8);

        Assert.NotNull(problem);
        Assert.Equal("urn:ietf:params:acme:error:badCSR", problem.Type);
        Assert.Equal(AcmeErrorType.BadCsr, problem.ErrorType);
        Assert.Equal("The key is too short", problem.Detail);
        Assert.Equal(400, problem.Status);
    }

    [Theory]
    [InlineData("accountDoesNotExist", "AccountDoesNotExist")]
    [InlineData("alreadyReplaced", "AlreadyReplaced")]
    [InlineData("alreadyRevoked", "AlreadyRevoked")]
    [InlineData("badNonce", "BadNonce")]
    [InlineData("badRevocationReason", "BadRevocationReason")]
    [InlineData("caa", "Caa")]
    [InlineData("compound", "Compound")]
    [InlineData("connection", "Connection")]
    [InlineData("dns", "Dns")]
    [InlineData("externalAccountRequired", "ExternalAccountRequired")]
    [InlineData("incorrectResponse", "IncorrectResponse")]
    [InlineData("malformed", "Malformed")]
    [InlineData("orderNotReady", "OrderNotReady")]
    [InlineData("rateLimited", "RateLimited")]
    [InlineData("rejectedIdentifier", "RejectedIdentifier")]
    [InlineData("serverInternal", "ServerInternal")]
    [InlineData("tls", "Tls")]
    [InlineData("unauthorized", "Unauthorized")]
    [InlineData("userActionRequired", "UserActionRequired")]
    public void Every_registered_acme_error_type_is_recognized(string name, string expected)
    {
        var problem = AcmeProblem.TryParse(Encoding.UTF8.GetBytes($$"""{"type":"urn:ietf:params:acme:error:{{name}}"}"""));

        Assert.Equal(Enum.Parse<AcmeErrorType>(expected), problem!.ErrorType);
    }

    [Fact]
    public void A_type_outside_the_acme_namespace_is_kept_but_unknown()
    {
        var problem = AcmeProblem.TryParse("""{"type":"https://ca.example/errors/busy","title":"Busy"}"""u8);

        Assert.Equal(AcmeErrorType.Unknown, problem!.ErrorType);
        Assert.Equal("https://ca.example/errors/busy", problem.Type);
        Assert.Equal("Busy", problem.Describe());
    }

    [Fact]
    public void Subproblems_say_which_identifier_they_are_about()
    {
        var problem = AcmeProblem.TryParse("""
            {
              "type": "urn:ietf:params:acme:error:compound",
              "detail": "Some identifiers were rejected",
              "subproblems": [
                {"type": "urn:ietf:params:acme:error:caa", "detail": "CAA forbids issuance",
                 "identifier": {"type": "dns", "value": "one.example"}},
                {"type": "urn:ietf:params:acme:error:rejectedIdentifier", "detail": "Blocked",
                 "identifier": {"type": "dns", "value": "two.example"}}
              ]
            }
            """u8);

        Assert.Equal(2, problem!.Subproblems.Count);
        Assert.Equal("one.example", problem.Subproblems[0].Identifier!.Value);
        Assert.Equal(AcmeErrorType.RejectedIdentifier, problem.Subproblems[1].ErrorType);
        Assert.Equal(
            "Some identifiers were rejected (one.example: CAA forbids issuance; two.example: Blocked)",
            problem.Describe());
    }

    [Theory]
    [InlineData("<html>Bad gateway</html>")]
    [InlineData("[1, 2]")]
    [InlineData("")]
    [InlineData("{\"type\": 42}")]
    public void A_body_that_is_not_a_problem_document_gives_nothing(string body)
    {
        Assert.Null(AcmeProblem.TryParse(Encoding.UTF8.GetBytes(body)));
    }

    [Fact]
    public void Server_text_loses_control_characters_and_is_cut_short()
    {
        var detail = "Rejected\r\n2026-10-01 fake log line\t" + new string('x', 2000);
        var problem = AcmeProblem.TryParse(Encoding.UTF8.GetBytes(
            $$"""{"type":"urn:ietf:params:acme:error:malformed","detail":{{System.Text.Json.JsonSerializer.Serialize(detail)}}}"""));

        var described = problem!.Describe();

        Assert.DoesNotContain('\r', described);
        Assert.DoesNotContain('\n', described);
        Assert.StartsWith("Rejected 2026-10-01 fake log line x", described, StringComparison.Ordinal);
        Assert.True(described.Length <= 501, $"{described.Length} characters");
    }

    [Fact]
    public void A_rate_limit_becomes_its_own_exception_with_the_time_to_try_again()
    {
        var problem = AcmeProblem.TryParse(
            """{"type":"urn:ietf:params:acme:error:rateLimited","detail":"Too many new orders recently"}"""u8)!;
        var retryAt = new DateTimeOffset(2026, 10, 2, 8, 30, 0, TimeSpan.Zero);

        var error = AcmeProblemException.Create("Ordering the certificate", problem, HttpStatusCode.TooManyRequests, retryAt);

        var limited = Assert.IsType<AcmeRateLimitedException>(error);
        Assert.Equal(retryAt, limited.RetryAt);
        Assert.Equal(AcmeErrorType.RateLimited, limited.ErrorType);
        Assert.Equal(
            "Ordering the certificate was rate limited by the CA; try again after 2026-10-02 08:30:00Z: Too many new orders recently",
            limited.Message);
    }

    [Fact]
    public void Any_other_problem_names_the_step_the_type_and_the_detail()
    {
        var problem = AcmeProblem.TryParse(
            """{"type":"urn:ietf:params:acme:error:badCSR","detail":"The key is too short"}"""u8)!;

        var error = AcmeProblemException.Create("Finalizing the order", problem, HttpStatusCode.BadRequest, retryAt: null);

        Assert.IsNotType<AcmeRateLimitedException>(error);
        Assert.Equal(HttpStatusCode.BadRequest, error.StatusCode);
        Assert.Equal("Finalizing the order failed (badCSR): The key is too short", error.Message);
    }
}
