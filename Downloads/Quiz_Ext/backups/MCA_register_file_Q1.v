module register_file (
    input clk,
    input we,
    input [1:0] wr_addr,
    input [31:0] wr_data,
    input [1:0] rd_addr1,
    input [1:0] rd_addr2,
    output [31:0] rd_data1,
    output [31:0] rd_data2
);

    // 4 registers, each 32-bit wide, initialized to 0
    reg [31:0] registers [0:3];

    integer i;
    initial begin
        for (i = 0; i < 4; i = i + 1) begin
            registers[i] = 32'b0;
        end
    end

    // Synchronous write port
    always @(posedge clk) begin
        if (we) begin
            registers[wr_addr] <= wr_data;
        end
    end

    // Asynchronous (combinational) read ports
    assign rd_data1 = registers[rd_addr1];
    assign rd_data2 = registers[rd_addr2];

endmodule
