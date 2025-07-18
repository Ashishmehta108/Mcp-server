import { configDotenv } from "dotenv";
configDotenv();
import express, { Request, Response } from "express";
import cors from "cors";
import axios from "axios";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import prisma from "../utils/db.js";
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.MCP_CLIENT || "http://localhost:5500",
    credentials: true,
  })
);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

const transports: Record<string, StreamableHTTPServerTransport> = {};
const server = new McpServer({ name: "Bytecraft-mcp", version: "1.0.0" });
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { Pinecone } from "@pinecone-database/pinecone";
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API!,
});

const prodIndex = pinecone.Index("my-prod").namespace("prod-namespace");

const searchVector = async (query: string) => {
  const vector = await new GoogleGenAI({
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
  }).models.embedContent({
    model: "text-embedding-004",
    contents: [query],
  });
  if (!vector.embeddings) throw new Error("No embeddings found");
  console.log(vector.embeddings[0].values);
  const res = await prodIndex.query({
    vector: vector.embeddings[0].values as number[],
    topK: 2,
    includeMetadata: true,
  });
  console.log(res);
  return res.matches;
};

server.registerTool(
  "ExtractDetailsFromthePrompt",
  {
    description:
      "Extract keywords from a natural language prompt, such as product type or area of use, and dynamically call corresponding tools to retrieve product data.",
    inputSchema: {
      prompt: z
        .string()
        .nonempty()
        .describe(
          "A user prompt like 'Show me all outdoor lamps and give details for the first one'."
        ),
    },
  },
  async ({ prompt }) => {
    console.log(
      "[Tool Called] ExtractDetailsFromthePrompt with prompt:",
      prompt
    );
    const keywords = prompt.toLowerCase();
    const allTypes = await prisma.product.findMany({
      distinct: ["type"],
      select: { type: true },
    });
    const allUses = await prisma.product.findMany({
      distinct: ["areaOfUse"],
      select: { areaOfUse: true },
    });
    const matchedType = allTypes.find((t) =>
      keywords.includes(t.type?.toLowerCase() || "")
    );
    const matchedUse = allUses.find((u) =>
      keywords.includes(u.areaOfUse?.toLowerCase() || "")
    );

    if (matchedType) {
      const products = await prisma.product.findMany({
        where: { type: matchedType.type },
      });
      const first = products[0];
      const result = {
        typeMatched: matchedType.type,
        products,
        ...(first && {
          details: {
            name: first.name,
            price: first.price,
            company: first.company,
          },
        }),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    if (matchedUse) {
      const products = await prisma.product.findMany({
        where: { areaOfUse: matchedUse.areaOfUse },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              areaMatched: matchedUse.areaOfUse,
              products,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: "No matching type or areaOfUse found in prompt.",
        },
      ],
    };
  }
);

server.registerTool(
  "findProductByType",
  {
    description:
      "Fetch products by category/type, such as 'lamp', 'chair', or 'sofa'. This tool is useful when users specify a product category in their query, like 'show all chairs'.",
    inputSchema: {
      type: z
        .string()
        .nonempty()
        .describe("Product category (e.g., 'lamp', 'chair')"),
    },
  },
  async ({ type }) => {
    console.log("[Tool Called] findProductByType with type:", type);

    const products = await prisma.product.findMany({ where: { type } });
    return { content: [{ type: "text", text: JSON.stringify(products) }] };
  }
);

server.registerTool(
  "findProductByUse",
  {
    description:
      "Fetch products designed for a specific use case or context, like 'outdoor seating', 'study area', or 'living room'. Use this when user prompts refer to how or where the product will be used.",
    inputSchema: {
      areaOfUse: z
        .string()
        .nonempty()
        .describe("Usage context (e.g., 'outdoor', 'indoor')"),
    },
  },
  async ({ areaOfUse }) => {
    console.log("[Tool Called] findProductByUse with areaOfUse:", areaOfUse);

    const products = await prisma.product.findMany({ where: { areaOfUse } });
    return { content: [{ type: "text", text: JSON.stringify(products) }] };
  }
);

server.registerTool(
  "getProductInfo",
  {
    description:
      "Get detailed info about a product including name, description, price, image, and company. Use when user asks about a specific model or product name.",
    inputSchema: {
      name: z.string().nonempty().describe("Exact product name to lookup"),
    },
  },
  async ({ name }) => {
    console.log("[Tool Called] getProductInfo with name:", name);

    const prod = await prisma.product.findFirst({ where: { name } });
    const info = {
      description: prod?.description ?? null,
      price: prod?.price ?? null,
      productId: prod?.id ?? null,
      image: prod?.image ?? null,
      company: prod?.company ?? null,
    };
    return { content: [{ type: "text", text: JSON.stringify(info) }] };
  }
);

server.registerTool(
  "getAllProducts",
  {
    description:
      "List all products available in the catalog. Use when user wants to browse everything or has not applied any filter.",
    inputSchema: {},
  },
  async () => {
    console.log("[Tool Called] getAllProducts");

    const products = await prisma.product.findMany();
    return { content: [{ type: "text", text: JSON.stringify(products) }] };
  }
);

server.registerTool(
  "addToCart",
  {
    description:
      "Add a selected product to the shopping cart. Triggered when user says 'Add this to my cart' or clicks a button.",
    inputSchema: {
      productId: z
        .string()
        .nonempty()
        .describe("Unique product ID to add to cart"),
      quantity: z
        .number()
        .optional()
        .default(1)
        .describe("Number of items to add"),
      userId: z.string().describe("User ID to add product in  the cart"),
    },
  },
  async ({ productId, quantity, userId }) => {
    console.log(
      "[Tool Called] addToCart with productId:",
      productId,
      "quantity:",
      quantity
    );

    try {
      const response = await fetch(`${process.env.FRONTEND_URL}/api/cart`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId, quantity: quantity ?? 1, userId }),
      });

      return {
        content: [
          {
            type: "text",
            text: await response.text(),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          { type: "text", text: `Error adding to cart: ${err.message}` },
        ],
      };
    }
  }
);

server.registerTool(
  "removeFromCart",
  {
    description:
      "Remove a selected product from the shopping cart. Triggered when user says 'Remove this from my cart' or clicks a button.",
    inputSchema: {
      productId: z
        .string()
        .nonempty()
        .describe("Unique product ID to remove from cart"),
      quantity: z
        .number()
        .optional()
        .default(1)
        .describe("Number of items to remove"),
      userId: z.string().describe("User ID to remove product in  the cart"),
    },
  },
  async ({ productId, quantity, userId }) => {
    console.log(
      "[Tool Called] removeFromCart with productId:",
      productId,
      "quantity:",
      quantity
    );

    try {
      const response = await fetch(`${process.env.FRONTEND_URL}/api/cart`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId, quantity: quantity ?? 1, userId }),
      });

      return {
        content: [
          {
            type: "text",
            text: await response.text(),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          { type: "text", text: `Error removing from cart: ${err.message}` },
        ],
      };
    }
  }
);

server.registerTool(
  "moreContextFromQuery",
  {
    description:
      "Get more context from a natural language query using vector db query.The llm calls it and then gets the most matching results and based upon the user context it should return the user best product based on their needs.",
    inputSchema: {
      query: z
        .string()
        .nonempty()
        .describe(
          "A user prompt like 'Show me all outdoor lamps and give details for the first one'."
        ),
    },
  },
  async ({ query }) => {
    console.log("[Tool Called] moreContextFromQuery with query:", query);
    try {
      const res = await searchVector(query);
      return {
        content: [
          {
            type: "text",
            text:
              "these are the most matching results of thee query from the database " +
              JSON.stringify(res),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting more context: ${error.message}`,
          },
        ],
      };
    }
  }
);

server.registerTool(
  "clearCart",
  {
    description:
      "Clear the user's cart. Triggered when user says 'Clear my cart' or clicks a button.",
    inputSchema: {
      userId: z.string().describe("User ID to clear cart for"),
    },
  },
  async ({ userId }) => {
    console.log("[Tool Called] clearCart");
    try {
      const response = await fetch(`${process.env.FRONTEND_URL}/api/cart`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId }),
      });

      return {
        content: [
          {
            type: "text",
            text: await response.text(),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          { type: "text", text: `Error clearing cart: ${err.message}` },
        ],
      };
    }
  }
);

server.registerTool(
  "getCart",
  {
    description:
      "Fetch all items currently in the user's cart. Use when user says 'Show my cart', 'What's in my cart?', etc.",
    inputSchema: {
      userId: z.string().describe("User ID to fetch cart for"),
    },
  },
  async ({ userId }) => {
    console.log("[Tool Called] getCart");
    const response = await axios.post(
      `${process.env.FRONTEND_URL}/api/cart/getcart`,
      {
        userId,
      }
    );
    return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
  }
);

// ────── MCP Routes ──────
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    await server.connect(transport);
  } else if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session ID" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.get("/", async (req: Request, res: Response) => {
  res.send("hello from aira's core backend");
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.get("/", (req: Request, res: Response) => {
  res.send("Hello from Bytecraft-mcp server");
});

setInterval(async () => {
  try {
    const response = await fetch(`${process.env.MCP_ClIENT}`);
  } catch (error) {
    console.error("Polling error:", error);
  }
}, 600000);

// ────── Start ──────
const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`✅ Bytecraft-mcp server running on port ${PORT}`);
});
