cmake_minimum_required(VERSION 3.10)
project(EvolutionWorldServer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_CXX_FLAGS_RELEASE "-O2")
add_compile_options(-Wall -Wextra -Wno-unused-parameter)

find_package(OpenSSL REQUIRED)

file(GLOB SERVER_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/util/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/game/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/auth/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/anticheat/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/net/*.cpp
)

add_executable(evolution_server ${SERVER_SOURCES})
target_include_directories(evolution_server PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(evolution_server PRIVATE OpenSSL::Crypto)
