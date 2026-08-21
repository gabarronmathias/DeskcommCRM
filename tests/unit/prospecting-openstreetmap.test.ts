import { afterEach, describe, expect, it, vi } from "vitest";

import { searchFoodserviceOpenStreetMap } from "@/lib/prospecting/openstreetmap";

const cities = [
  "São José dos Campos,SP",
  "Jacareí,SP",
  "Caçapava,SP",
  "Taubaté,SP",
  "Pindamonhangaba,SP",
];

afterEach(() => vi.unstubAllGlobals());

describe("coleta foodservice via OpenStreetMap", () => {
  it("aceita apenas estabelecimento-alvo com telefone comercial público", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      elements: [
        {
          type: "node",
          id: 10,
          lat: -23.22,
          lon: -45.90,
          tags: {
            name: "Pizza Teste",
            amenity: "restaurant",
            cuisine: "pizza",
            "addr:city": "São José dos Campos",
            "addr:street": "Rua Pública",
            "contact:whatsapp": "+55 12 99999-0000",
          },
        },
        {
          type: "node",
          id: 11,
          lat: -23.22,
          lon: -45.90,
          tags: { name: "Contato privado", amenity: "restaurant", phone: "+55 12 3333-0000", access: "private" },
        },
        {
          type: "node",
          id: 12,
          lat: -23.22,
          lon: -45.90,
          tags: { name: "Sem telefone", amenity: "restaurant" },
        },
        {
          type: "node",
          id: 13,
          lat: -22.75,
          lon: -46.15,
          tags: { name: "Outra cidade", amenity: "restaurant", phone: "+55 11 3333-0000", "addr:city": "Guarulhos" },
        },
      ],
    }), { status: 200 })));

    const results = await searchFoodserviceOpenStreetMap({ cities, limit: 20, bbox: "-23.45,-46.20,-22.65,-45.30", urls: ["https://overpass.test"] });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: "openstreetmap",
      sourceId: "node/10",
      placeId: "osm:node/10",
      companyName: "Pizza Teste",
      category: "pizzaria",
      phoneRaw: "+55 12 99999-0000",
      city: "São José dos Campos",
      businessStatus: "OPERATIONAL",
    });
  });

  it("usa a próxima instância quando a primeira está indisponível", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ elements: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchFoodserviceOpenStreetMap({
      cities,
      limit: 20,
      bbox: "-23.45,-46.20,-22.65,-45.30",
      urls: ["https://first.test", "https://second.test"],
    })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
