import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();

const tools: Anthropic.Tool[] = [{
    name:"get_weather",
    description: "get current weather for a city",
    input_schema:{
        type:"object",
        properties:{city:{type:"string"}},
        required:["city"]
    },
}]

async function runTool(name:string, input:any): Promise<string>{

    if(name==="get_weather") return `Sunny ,31°C in ${input.city}`; 
    return "unknown tool";

}

async function agent(task:string){
    const messages: Anthropic.MessageParam[] = [{
        role:"user",
        content:task
    }];

    for (let step=0;step<10;step++){
        const res = await client.messages.create({
            model:"claude-opus-5",
            max_tokens:1024,
            tools,
            messages,
        });
        messages.push({role:"assistant",content:res.content})
        if(res.stop_reason !== "tool_use") return res;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for(const block of res.content){
            if(block.type === "tool_use"){
                results.push({
                    type:"tool_result",
                    tool_use_id:block.id,
                    content: await runTool(block.name,block.input)
                })
            }
        }
        messages.push({role:"user", content:results});
    }

    throw new Error("Max steps reached");
}