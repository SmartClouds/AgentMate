using System.Net;
using System.Text;
using Runova.ServerCore.Cloudflare;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// The core's Cloudflare client against recorded answers: the ranges without a token, DNS calls
/// with the zone's token as a bearer header only, and Cloudflare's refusals in words that never
/// carry the token.
/// </summary>
public sealed class CloudflareApiTests
{
    private const string ZoneId = "023e105f4ecef8ad9ca31a8372d0c353";
    private const string Token = "Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private sealed class Recorder(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<(HttpMethod Method, string Url, string? Authorization, string? Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add((request.Method, request.RequestUri!.ToString(), request.Headers.Authorization?.ToString(), body));
            return answer(request);
        }
    }

    private sealed class Http(HttpMessageHandler handler) : ICloudflareHttp
    {
        public HttpClient Client { get; } = new(handler);
    }

    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static (CloudflareApi Api, Recorder Recorder) Api(Func<HttpRequestMessage, HttpResponseMessage> answer)
    {
        var recorder = new Recorder(answer);
        return (new CloudflareApi(new Http(recorder)), recorder);
    }

    [Fact]
    public async Task The_ranges_come_from_the_ips_endpoint_without_a_token()
    {
        var (api, recorder) = Api(_ => Json(CloudflareRecordings.Ips));

        var ranges = await api.FetchAsync(Cancel);

        Assert.Equal(CloudflareRecordings.Ipv4.Order(StringComparer.Ordinal), ranges.Ipv4);
        Assert.Equal(CloudflareRecordings.Ipv6.Order(StringComparer.Ordinal), ranges.Ipv6);
        var request = Assert.Single(recorder.Requests);
        Assert.Equal("https://api.cloudflare.com/client/v4/ips", request.Url);
        Assert.Null(request.Authorization);
    }

    [Fact]
    public async Task A_txt_record_is_made_with_the_zone_token_and_a_short_ttl()
    {
        var (api, recorder) = Api(_ => Json("""{"success":true,"errors":[],"result":{"id":"372e67954025e0ba6aaa6d586b9e0b59"}}"""));

        var id = await api.CreateTxtAsync(ZoneId, Token, "_acme-challenge.example.com", "abc-123_value", Cancel);

        Assert.Equal("372e67954025e0ba6aaa6d586b9e0b59", id);
        var request = Assert.Single(recorder.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal($"https://api.cloudflare.com/client/v4/zones/{ZoneId}/dns_records", request.Url);
        Assert.Equal($"Bearer {Token}", request.Authorization);
        Assert.Contains("\"type\":\"TXT\"", request.Body, StringComparison.Ordinal);
        Assert.Contains("\"name\":\"_acme-challenge.example.com\"", request.Body, StringComparison.Ordinal);
        Assert.Contains("\"content\":\"abc-123_value\"", request.Body, StringComparison.Ordinal);
        Assert.Contains("\"ttl\":60", request.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(Token, request.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Records_are_found_by_name_with_quotes_taken_off_and_deleted_by_id()
    {
        var (api, recorder) = Api(request => request.Method == HttpMethod.Get
            ? Json("""{"success":true,"errors":[],"result":[{"id":"372e67954025e0ba6aaa6d586b9e0b59","name":"_acme-challenge.example.com","content":"\"abc\""}]}""")
            : Json("""{"success":true,"errors":[],"result":{"id":"372e67954025e0ba6aaa6d586b9e0b59"}}"""));

        var found = Assert.Single(await api.FindTxtAsync(ZoneId, Token, "_acme-challenge.example.com", Cancel));
        await api.DeleteAsync(ZoneId, Token, found.Id, Cancel);

        Assert.Equal("abc", found.Content);
        Assert.Equal($"https://api.cloudflare.com/client/v4/zones/{ZoneId}/dns_records?type=TXT&per_page=100&name=_acme-challenge.example.com", recorder.Requests[0].Url);
        Assert.Equal((HttpMethod.Delete, $"https://api.cloudflare.com/client/v4/zones/{ZoneId}/dns_records/{found.Id}"), (recorder.Requests[1].Method, recorder.Requests[1].Url));
    }

    [Fact]
    public async Task A_token_without_dns_rights_is_named_and_the_token_never_appears_in_the_answer()
    {
        var (api, _) = Api(_ => Json(CloudflareRecordings.AuthenticationError, HttpStatusCode.Forbidden));

        var problem = await api.CheckAsync(ZoneId, Token, Cancel);
        var refused = await Assert.ThrowsAsync<CloudflareApiException>(() => api.CreateTxtAsync(ZoneId, Token, "_acme-challenge.example.com", "x", Cancel));

        Assert.Equal("This token cannot read the zone's DNS records (Authentication error (code 10000)). It needs Zone > DNS > Edit on this zone.", problem);
        Assert.Equal(HttpStatusCode.Forbidden, refused.Status);
        Assert.DoesNotContain(Token, refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_rejected_token_says_so()
    {
        var (api, _) = Api(_ => Json("""{"success":false,"errors":[{"code":9109,"message":"Invalid access token"}],"result":null}""", HttpStatusCode.Unauthorized));

        Assert.StartsWith("Cloudflare does not accept this token", await api.CheckAsync(ZoneId, Token, Cancel), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Deleting_a_record_that_is_gone_already_is_fine()
    {
        var (api, _) = Api(_ => Json("""{"success":false,"errors":[{"code":81044,"message":"Record does not exist."}],"result":null}""", HttpStatusCode.NotFound));

        await api.DeleteAsync(ZoneId, Token, "372e67954025e0ba6aaa6d586b9e0b59", Cancel);
    }

    [Theory]
    [InlineData("not-a-zone", Token)]
    [InlineData(ZoneId, "short")]
    [InlineData(ZoneId, "Gm4pR2e6Tq9VxYb1Lk0N\r\nX-Injected: yes")]
    public async Task Ids_and_tokens_that_could_reshape_the_request_are_refused_before_sending(string zoneId, string token)
    {
        var (api, recorder) = Api(_ => Json("{}"));

        await Assert.ThrowsAsync<CloudflareApiException>(() => api.CreateTxtAsync(zoneId, token, "_acme-challenge.example.com", "x", Cancel));

        Assert.Empty(recorder.Requests);
    }

    [Fact]
    public async Task An_unreachable_api_is_a_plain_refusal()
    {
        var (api, _) = Api(_ => throw new HttpRequestException("Name or service not known"));

        var refused = await Assert.ThrowsAsync<CloudflareApiException>(() => api.FetchAsync(Cancel));

        Assert.Equal("Cloudflare could not be reached: Name or service not known", refused.Message);
    }
}
