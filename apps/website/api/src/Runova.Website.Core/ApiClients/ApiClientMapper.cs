using Riok.Mapperly.Abstractions;

namespace Runova.Website.Core.ApiClients;

[Mapper]
public static partial class ApiClientMapper
{
    public static partial ApiClientDto ToDto(ApiClient client);

    private static partial ApiClientKeyDto ToDto(ApiClientKey key);
}
