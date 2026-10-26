using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class CloudflareOriginAndDns : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DnsCredentials",
                columns: table => new
                {
                    Zone = table.Column<string>(type: "TEXT", maxLength: 253, nullable: false),
                    ZoneId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    Provider = table.Column<string>(type: "TEXT", maxLength: 40, nullable: false),
                    ProtectedToken = table.Column<string>(type: "TEXT", nullable: false),
                    TokenId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    CreatedBy = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                    LastUsedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    LastError = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DnsCredentials", x => x.Zone);
                });

            migrationBuilder.CreateTable(
                name: "OriginCertificateKeys",
                columns: table => new
                {
                    SiteId = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                    ProtectedKey = table.Column<string>(type: "TEXT", nullable: false),
                    Hostnames = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OriginCertificateKeys", x => x.SiteId);
                });

            migrationBuilder.CreateTable(
                name: "OriginLock",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    AuthenticatedOriginPulls = table.Column<bool>(type: "INTEGER", nullable: false),
                    Ipv4 = table.Column<string>(type: "TEXT", nullable: false),
                    Ipv6 = table.Column<string>(type: "TEXT", nullable: false),
                    RangesFetchedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    LastRefreshAt = table.Column<long>(type: "INTEGER", nullable: true),
                    LastRefreshError = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    ChangeSetId = table.Column<Guid>(type: "TEXT", nullable: true),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OriginLock", x => x.Id);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DnsCredentials");

            migrationBuilder.DropTable(
                name: "OriginCertificateKeys");

            migrationBuilder.DropTable(
                name: "OriginLock");
        }
    }
}
