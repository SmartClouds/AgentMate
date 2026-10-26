using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class Registries : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "RegistryCredentials",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Registry = table.Column<string>(type: "TEXT", maxLength: 260, nullable: false),
                    Username = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    SealedSecret = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    CreatedBy = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                    LastUsedAt = table.Column<long>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RegistryCredentials", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_RegistryCredentials_Registry",
                table: "RegistryCredentials",
                column: "Registry",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "RegistryCredentials");
        }
    }
}
